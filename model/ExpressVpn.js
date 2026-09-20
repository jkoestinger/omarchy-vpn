.pragma library
.import "Shared.js" as Shared

// ExpressVPN, via `expressvpnctl` talking to its daemon. Parsing and
// row-building only — the process plumbing lives in ExpressVpnBackend.qml.
//
// `expressvpnctl` is the v14 CLI. The older `expressvpn` wrapper that needed
// sudo for connect is gone from current installs and is not handled here.

// nf-md-server-network, the glyph Proton uses for country rows too. ExpressVPN
// has no icon of its own in the font, and the rows are places.
var GLYPH_EXPRESSVPN = Shared.GLYPH_VPN

// ------------------------------------------------------------------ status
//
// `expressvpnctl status` prints a plain-text block whose lines come and go
// with the state. Collected from expressvpnctl 14.x on Arch:
//
//   Not connected
//
// and while a tunnel is up:
//
//   Connected to 162.159.132.117
//   Protocol: Lightway UDP
//   Location: Germany - Frankfurt - 1 (or similar region name)
//
// The docs name the location line as the region the user connected to; older
// builds print only the server address. So this matches on the leading key of
// each line rather than on line position — the same reason Windscribe's
// parser does — and an unrecognised block is "no idea", not disconnected.
function parseExpressStatus(raw) {
  var result = {
    loaded: false,
    state: "",
    connected: false,
    location: "",
    protocol: "",
    error: "",
    statusText: ""
  }

  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue

    // A bare "Not connected" line has no colon to split on.
    if (/^not connected$/i.test(line)) {
      result.loaded = true
      result.state = "disconnected"
      result.statusText = "Not connected"
      continue
    }

    var connected = line.match(/^connected\s+to\s+(.+)$/i)
    if (connected) {
      result.loaded = true
      result.state = "connected"
      result.connected = true
      result.location = connected[1].trim()
      result.statusText = "Connected"
      continue
    }

    if (/^connecting\b/i.test(line)) {
      result.loaded = true
      result.state = "connecting"
      result.statusText = "Connecting"
      continue
    }

    if (/^disconnecting\b/i.test(line)) {
      result.loaded = true
      result.state = "disconnecting"
      result.statusText = "Disconnecting"
      continue
    }

    var separator = line.indexOf(":")
    if (separator < 0) continue

    var key = line.substring(0, separator).trim().toLowerCase()
    var value = line.substring(separator + 1).trim()
    if (value === "") continue

    if (key === "protocol") {
      result.protocol = value
    } else if (key === "location") {
      result.location = value
      if (result.state === "") {
        result.loaded = true
        result.state = "connected"
        result.connected = true
      }
    } else if (key === "error") {
      result.error = value
    }
  }

  return result
}

// Whether a status block says anything at all. Kept next to the parser because
// the backend needs it for the same reason: an answer that says nothing is not
// news, and the last reading is kept rather than replaced with a blank one.
function statusLoaded(status) {
  return !!status && status.loaded === true
}

// ----------------------------------------------------------------- regions
//
// `expressvpnctl get regions` prints one region per line. Collected from
// expressvpnctl 14.x:
//
//   Smart Location
//   USA - New York
//   USA - New York - 1
//   Germany - Frankfurt - 1
//   Switzerland - Zurich - 1
//   Serbia
//
// Every line is a legal argument to `connect`, taken whole. The pieces before
// the trailing dash number are the country (and sometimes the city), which the
// list rows and the favorites match are built from.
function parseRegions(raw) {
  var regions = []
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    // The Smart Location row is the pseudo-region `connect` resolves on its
    // own; it is not a place, so it is handled by the quick row instead.
    if (/^smart location$/i.test(line)) continue
    if (line.charAt(0) === "-") continue

    var parts = line.split(" - ")
    for (var p = 0; p < parts.length; p++) parts[p] = parts[p].trim()

    // "Germany - Frankfurt - 1": the trailing segment that is just a number is
    // a server index, not a city, and the country is what the row is grouped
    // by. A city that is genuinely a number does not exist.
    var tail = parts[parts.length - 1]
    if (/^\d+$/.test(tail)) {
      parts.pop()
      tail = parts[parts.length - 1]
    }

    var country = parts[0]
    if (country === "") continue

    var city = parts.length > 1 ? parts.slice(1).join(" - ") : ""

    var exists = false
    for (var r = 0; r < regions.length; r++) {
      if (regions[r].country === country) {
        exists = true
        if (city !== "" && regions[r].cities.indexOf(city) < 0) regions[r].cities.push(city)
        break
      }
    }
    if (!exists) {
      regions.push({ country: country, name: line, cities: city !== "" ? [city] : [] })
    }
  }
  return regions
}

// ExpressVPN names its regions and never prints a country code, so the
// favorites setting is matched by name — "Switzerland" — and by leading word,
// which is what makes "US" pick up USA. Same situation as Windscribe's.
function isExpressFavorite(name, favorites) {
  if (!favorites || favorites.length === 0) return false

  var country = String(name || "").toUpperCase()
  var head = country.split(" ")[0]
  for (var i = 0; i < favorites.length; i++) {
    if (favorites[i] === country || favorites[i] === head) return true
  }
  return false
}

// ------------------------------------------------------------------ rows

// "Smart location" is ExpressVPN's own default: `connect` with no argument
// resolves it, and it is the closest thing the tool has to a quick row.
function expressQuickTargets(status) {
  var connecting = status && status.state === "connecting"
  var detail = connecting ? "Connecting…" : "Let ExpressVPN pick"
  return [
    {
      key: "smart",
      label: "Smart location",
      detail: detail,
      glyph: Shared.GLYPH_BOLT,
      args: []
    }
  ]
}

function expressTargets(regions, favorites, filter) {
  var needle = String(filter || "").trim().toLowerCase()
  var favored = []
  var rest = []

  for (var i = 0; i < regions.length; i++) {
    var region = regions[i]
    if (needle !== "") {
      var haystack = (region.country + " " + region.cities.join(" ")).toLowerCase()
      if (haystack.indexOf(needle) < 0) continue
    }

    var target = {
      key: "region:" + region.country.toLowerCase(),
      label: region.country,
      detail: region.cities.length > 0 ? region.cities.join(" · ") : "",
      glyph: GLYPH_EXPRESSVPN,
      // `connect` takes a region name as the list printed it — the docs' own
      // example is "Germany - Frankfurt - 1" — and resolves an unnumbered one
      // to its first server. The country row connects to the first region
      // name the list carried for that country.
      args: [region.name]
    }
    if (needle === "" && isExpressFavorite(region.country, favorites)) favored.push(target)
    else rest.push(target)
  }

  return favored.concat(rest)
}

// The status names the region the user connected to, so the row to tick is
// found by matching that name back against the list — country first, then the
// leading word, which is what makes "Germany - Frankfurt - 1" tick Germany.
function expressCurrentKey(status, regions) {
  if (!status || (status.state !== "connected" && status.state !== "connecting")) return ""

  var location = String(status.location || "").toLowerCase()
  if (location === "") return ""

  for (var i = 0; i < regions.length; i++) {
    var country = regions[i].country.toLowerCase()
    if (location === country || location.indexOf(country + " - ") === 0 || location.indexOf(country + "-") === 0) {
      return "region:" + country
    }
  }
  return ""
}

// ---------------------------------------------------------------- summary

function expressSummary(status) {
  if (!status.loaded) return "Checking…"
  if (status.state === "connected") {
    return status.location !== "" ? status.location : "Connected"
  }
  if (status.state === "connecting") return "Connecting…"
  if (status.state === "disconnecting") return "Disconnecting…"
  if (status.state === "disconnected") return "Not connected"
  return "Checking…"
}

function expressDetails(status) {
  if (status.state !== "connected") return []

  var rows = []
  if (status.location !== "") rows.push(Shared.detail("Location", status.location))
  if (status.protocol !== "") rows.push(Shared.detail("Protocol", status.protocol))
  return rows.filter(function(row) { return row.value !== "" })
}

// --------------------------------------------------------------- settings

// One switchable setting: Network Lock, ExpressVPN's kill switch. Its value is
// always what the daemon last reported; the widget stores no copy. Read from
// `expressvpnctl get networklock`, which prints `Network lock: on` (or `off`).
function parseNetworkLock(raw) {
  var result = { known: false, on: false }
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    var separator = line.indexOf(":")
    if (separator < 0) continue

    var key = line.substring(0, separator).trim().toLowerCase()
    var value = line.substring(separator + 1).trim().toLowerCase()

    if (key === "network lock" || key === "networklock") {
      if (value === "on" || value === "true" || value === "enabled") {
        result.known = true
        result.on = true
      } else if (value === "off" || value === "false" || value === "disabled") {
        result.known = true
        result.on = false
      }
    }
  }
  return result
}

// The value is always what the tool last said, so this reports the reading
// even while a connect is up — the panel is only the mirror.
function expressToggles(lock) {
  if (!lock || !lock.known) return []

  return [
    Shared.toggle("networklock", "Network Lock",
      "Block traffic outside the tunnel", lock.on)
  ]
}

function expressToggleArgs(key, value) {
  if (key === "networklock") return ["set", "networklock", value ? "true" : "false"]
  return []
}

// ------------------------------------------------------------- setup states
//
// The things that stand between an installed expressvpnctl and a usable
// tunnel. Collected from expressvpnctl 14.x:
//
//   Signed out:   `Not logged in` on every read, exit 1
//   Background:   `Background mode is not enabled` on every read, exit 1
//   Unreachable:  the daemon is not answering — installed, nothing behind it
//
// Each has the command that clears it and how to say so: as the setup hint
// while ExpressVPN is not listed, and as the error when a command runs into
// it. Every command needs a person at the keyboard — the activation code
// prompt, or the enable command for background mode — so both go through the
// setup path the WARP backend established.
var EXPRESS_SETUP = {
  login: {
    command: "expressvpnctl login",
    hint: "ExpressVPN is installed but not logged in. Log in with: expressvpnctl login",
    failure: "ExpressVPN is not logged in. Log in with: expressvpnctl login"
  },
  background: {
    command: "expressvpnctl background enable",
    hint: "ExpressVPN is installed but its daemon is not reachable. Run: expressvpnctl background enable (or start the ExpressVPN app)",
    failure: "ExpressVPN is not reachable. Run: expressvpnctl background enable (or start the ExpressVPN app)"
  },
  status: {
    command: "expressvpnctl status",
    hint: "ExpressVPN is installed but its status could not be read. Run expressvpnctl status in a terminal to see why",
    failure: "ExpressVPN's status could not be read. Run expressvpnctl status in a terminal to see why"
  }
}

// Which of EXPRESS_SETUP keeps the backend from being `detected`, or "" when
// nothing does. Signed out wins over background mode: an account that cannot
// sign in cannot reach the background-mode question either.
function expressSetupState(probe) {
  if (!probe || !probe.present) return ""
  if (probe.needsLogin) return "login"
  if (probe.needsBackground) return "background"
  if (probe.needsStatusCheck) return "status"
  return ""
}

function expressSetupHint(probe) {
  var state = expressSetupState(probe)
  return state === "" ? "" : EXPRESS_SETUP[state].hint
}

function expressSetupCommand(probe) {
  var state = expressSetupState(probe)
  return state === "" ? "" : EXPRESS_SETUP[state].command
}

// ------------------------------------------------------------- diagnostics

// Whether a failed command's output names one of the setup states, or "".
// The spellings are expressvpnctl 14.x's own, from the binary rather than
// guessed; an unknown failure is shown as the tool's own words instead.
function expressFailureState(output) {
  var text = String(output || "")
  if (/not logged in|not activated|activation required|please (log ?in|activate)/i.test(text)) return "login"
  if (/background mode (is )?not enabled|enable background mode/i.test(text)) return "background"
  return ""
}

function describeExpressFailure(output, fallback) {
  var text = String(output || "").trim()
  var state = expressFailureState(text)
  if (state !== "") return EXPRESS_SETUP[state].failure
  return Shared.elide(text || fallback, 140)
}

// Whether a status read that failed says the tool is signed out. Kept here so
// the backend and the tests agree on what "signed out" looks like — a signed
// out CLI is a setup state, not a tool that is unwell.
function isExpressSignedOut(output) {
  return /not logged in|not activated|activation required/i.test(String(output || ""))
}

// Whether a read that failed says background mode is off. Same story: the
// CLI is present and signed in, but the daemon refuses until background mode
// is enabled or the GUI app is running.
function isExpressBackgroundOff(output) {
  return /background mode (is )?not enabled|enable background mode/i.test(String(output || ""))
}
