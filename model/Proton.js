.pragma library
.import "Shared.js" as Shared

// Proton VPN, via the `protonvpn` CLI. Parsing and row-building only — the
// process plumbing lives in ProtonBackend.qml.

// Two `protonvpn` processes must never overlap. Each one loads the stored
// session — including its refresh token — at startup and never re-reads it, and
// Proton rotates that token single-use. So when two of them straddle a token
// refresh, the winner trades the token and persists the new one, the loser
// posts the token that was just spent, `/auth/refresh` answers 400, and
// proton-core reads a 400 there as "this session is finished" and deletes it
// from the keyring. Nothing is logged. The user sees Proton VPN signing itself
// out, usually noticing after a reboot.
//
// Nothing inside one widget can prevent that: the bar instantiates the widget
// once per monitor, so a three-monitor desktop is three copies of this backend
// polling on their own timers, and a QML guard is invisible to the other two.
// A kernel file lock is not, so every invocation goes through one.
// XDG_RUNTIME_DIR is where it belongs — per-user, and cleared at logout — with
// the cache directory as a fallback for a session that somehow has no runtime
// dir. `-w 60` rather than an unbounded wait, so a wedged CLI costs one poll
// instead of every poll after it; `exec` so no shell sits around for the
// duration of a Python start.
var PROTON_CLI_LOCK = "${XDG_RUNTIME_DIR:-$HOME/.cache}/omarchy-vpn-protonvpn.lock"

function protonCli(args) {
  return [
    "sh", "-c",
    'exec flock -w 60 "' + PROTON_CLI_LOCK + '" protonvpn "$@"',
    // $0. `sh -c script name a b` puts a and b in "$@", and names the shell.
    "protonvpn"
  ].concat(args || [])
}

// Which of the poll's three reads to start now. They used to start together;
// with the lock above that only buys a queue three deep per monitor, which is
// long enough for one tick's commands to still be draining when the next tick
// adds three more. One at a time, each started by the previous one's exit,
// keeps the queue to one entry per instance.
//
// Order is what the panel wants first: the chip needs the status, the switches
// need the config, the rows need the country list.
function protonNextRead(state) {
  var known = state || {}
  if (known.busy) return ""
  if (known.statusDue) return "status"
  // Both of the others need an account, and a signed-out CLI refuses forever —
  // see protonAuthRequired.
  if (known.signedOut) return ""
  if (!known.configLoaded) return "config"
  if (!known.countriesLoaded) return "countries"
  return ""
}

// `protonvpn status` prints a plain-text block, not JSON:
//
//   Status: Connected
//   Server: NL#42
//   Country: Netherlands
//   Load: 40%
//   Protocol: WireGuard
//
// Labels vary between releases, so match on the leading key rather than on
// line position, and treat anything unrecognized as noise.
function parseProtonStatus(raw) {
  var result = {
    connected: false,
    server: "",
    country: "",
    city: "",
    load: "",
    protocol: "",
    statusText: ""
  }

  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue

    var separator = line.indexOf(":")
    if (separator < 0) {
      // Older builds print a bare "Connected to NL#42" sentence.
      var loose = line.match(/^connected\s+to\s+(.+)$/i)
      if (loose) {
        result.connected = true
        result.server = loose[1].trim()
      }
      continue
    }

    var key = line.substring(0, separator).trim().toLowerCase()
    var value = line.substring(separator + 1).trim()
    if (value === "") continue

    if (key === "status") {
      result.statusText = value
      result.connected = /^connected/i.test(value)
    } else if (key === "server" || key === "server name") {
      result.server = value
    } else if (key === "country") {
      result.country = value
    } else if (key === "city") {
      result.city = value
    } else if (key === "load" || key === "server load") {
      result.load = value
    } else if (key === "protocol") {
      result.protocol = value
    }
  }

  if (result.statusText === "") result.statusText = result.connected ? "Connected" : "Disconnected"

  // A connected CLI reports one combined field — "CH#1129 in Zurich,
  // Switzerland" — rather than the separate Country/City keys older builds
  // used. Split it so the panel can label the parts.
  var located = result.server.match(/^(\S+)\s+in\s+(.+)$/i)
  if (located) {
    result.server = located[1]
    var place = located[2].split(",")
    if (result.city === "" && place.length > 1) result.city = place[0].trim()
    if (result.country === "") result.country = (place.length > 1 ? place.slice(1).join(",") : place[0]).trim()
  }

  return result
}

// Anything that needs an account is refused the same way, whichever subcommand
// asked. Signed out, `protonvpn countries list` exits 2 with:
//
//   Error: Authentication required to view feature status. Please sign in with 'protonvpn signin'
//
// `protonvpn status` still exits 0 and prints "Status: Disconnected", so the
// poll notices nothing and keeps asking. Match on the phrases rather than the
// whole sentence: the tail names whichever feature was asked for, and the
// wording around it has moved between releases.
function protonAuthRequired(text) {
  return /authentication required|please sign\s?in|not (?:logged|signed)[- ]?in|sign in with/i.test(String(text || ""))
}

// Said in the CLI's own vocabulary, because the fix is a command the user runs.
var PROTON_SIGNIN_HINT = "Signed out of Proton VPN. Sign in with: protonvpn signin"

// `protonvpn countries list` prints a two-column table padded with spaces,
// preceded by an optional "Server list is outdated, updating..." notice and a
// dashed rule under the header.
function parseProtonCountries(raw) {
  var countries = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "" || line.indexOf("---") === 0) continue

    var match = line.match(/^(.+?)\s{2,}([A-Za-z]{2})$/)
    if (!match) continue

    var name = match[1].trim()
    var code = match[2].toUpperCase()
    if (name.toLowerCase() === "country") continue

    countries.push({ name: name, code: code })
  }
  return countries
}

// `protonvpn config list` prints a padded two-column table under a dashed rule:
//
//   Setting                  Value
//   -----------------------  ------------
//   netshield                malware-only
//   kill-switch              off
function parseProtonConfig(raw) {
  var values = {}
  var loaded = false
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "" || line.indexOf("---") === 0) continue

    var match = line.match(/^(\S+)\s{2,}(\S+)$/)
    if (!match) continue

    var key = match[1].toLowerCase()
    if (key === "setting") continue

    values[key] = match[2]
    loaded = true
  }

  return { values: values, loaded: loaded }
}

// Three of Proton's settings read as plain switches. The rest — custom DNS,
// NAT type, IPv6 — are not on/off questions and stay with the CLI.
function protonToggles(config) {
  if (!config || !config.loaded) return []

  var netshield = String(config.values["netshield"] || "off")
  var killSwitch = String(config.values["kill-switch"] || "off")

  return [
    Shared.toggle("kill-switch", "Kill switch",
      killSwitch !== "off" && killSwitch !== "standard"
        ? "Mode: " + killSwitch
        : "Cut traffic if the tunnel drops",
      killSwitch !== "off"),
    Shared.toggle("netshield", "NetShield",
      netshield !== "off" ? "Blocking: " + netshield : "Block ads, trackers, malware",
      netshield !== "off"),
    Shared.toggle("port-forwarding", "Port forwarding", "Open an inbound port for P2P",
      String(config.values["port-forwarding"] || "off") === "on")
  ]
}

// Turning one on means picking a value, since only "off" is shared. Switching
// one off and on again should land back on the mode it had — "malware-only" is
// a deliberate choice, and a switch that silently upgraded it to
// "malware-ads-trackers" would be changing a setting nobody asked it to change.
// `previousMode` is the last non-off value the tool reported.
function protonToggleArgs(key, value, previousMode) {
  var mode = String(previousMode || "")

  if (key === "kill-switch") {
    return ["config", "set", "kill-switch", value ? (mode !== "" ? mode : "standard") : "off"]
  }
  if (key === "netshield") {
    return ["config", "set", "netshield", value ? (mode !== "" ? mode : "malware-ads-trackers") : "off"]
  }
  if (key === "port-forwarding") return ["config", "set", "port-forwarding", value ? "on" : "off"]
  return []
}

// The modes worth remembering across an off/on round trip.
function protonModes(config, known) {
  var modes = {}
  for (var key in known) modes[key] = known[key]
  if (!config || !config.loaded) return modes

  var keys = ["kill-switch", "netshield"]
  for (var i = 0; i < keys.length; i++) {
    var value = String(config.values[keys[i]] || "off")
    if (value !== "off") modes[keys[i]] = value
  }
  return modes
}

function protonLocation(status) {
  var parts = []
  if (status.city !== "") parts.push(status.city)
  if (status.country !== "") parts.push(status.country)
  return parts.join(", ")
}

function protonSummary(status) {
  if (!status.connected) return "Not connected"

  var location = protonLocation(status)
  if (location !== "" && status.server !== "") return status.server + " · " + location
  if (location !== "") return location
  if (status.server !== "") return status.server
  return "Connected"
}

function protonDetails(status) {
  if (!status.connected) return []

  var rows = [Shared.detail("Server", status.server), Shared.detail("Location", protonLocation(status))]
  if (status.load !== "") rows.push(Shared.detail("Load", status.load))
  if (status.protocol !== "") rows.push(Shared.detail("Protocol", status.protocol))
  return rows.filter(function(row) { return row.value !== "" })
}

// Quick-connect rows above the country list. `args` is passed straight to
// `protonvpn connect`.
function protonQuickTargets() {
  return [
    { key: "fastest", label: "Fastest server", detail: "Best available worldwide", glyph: Shared.GLYPH_BOLT, args: [] },
    { key: "p2p", label: "P2P server", detail: "Fastest server that allows P2P", glyph: Shared.GLYPH_SWAP, args: ["--p2p"] },
    { key: "random", label: "Random server", detail: "Pick any available server", glyph: Shared.GLYPH_DICE, args: ["--random"] },
    { key: "securecore", label: "Secure Core", detail: "Route through a hardened entry", glyph: Shared.GLYPH_LOCK, args: ["--securecore"] }
  ]
}

// Favorites first, then the rest, with an optional substring filter over both
// the country name and its code.
function protonCountryTargets(countries, favorites, filter) {
  var needle = String(filter || "").trim().toLowerCase()
  var favored = []
  var rest = []

  for (var i = 0; i < countries.length; i++) {
    var country = countries[i]
    if (needle !== "") {
      var haystack = (country.name + " " + country.code).toLowerCase()
      if (haystack.indexOf(needle) < 0) continue
    }

    var target = {
      key: "country:" + country.code,
      label: country.name,
      detail: country.code,
      glyph: Shared.GLYPH_VPN,
      args: ["--country", country.code]
    }
    if (needle === "" && favorites.indexOf(country.code) >= 0) favored.push(target)
    else rest.push(target)
  }

  return favored.concat(rest)
}
