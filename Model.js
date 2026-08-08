.pragma library

// Nerd Font glyphs are built from codepoints instead of raw characters so the
// file survives editing tools that mangle multi-byte sequences.
var GLYPH_VPN = String.fromCodePoint(0xF0582)
var GLYPH_CHECK = String.fromCodePoint(0xF012C)
var GLYPH_LOCK = String.fromCodePoint(0xF033E)
var GLYPH_BOLT = String.fromCodePoint(0xF04C5)
var GLYPH_DICE = String.fromCodePoint(0xF01D5)
var GLYPH_SWAP = String.fromCodePoint(0xF04E1)
var GLYPH_CHEVRON_DOWN = String.fromCodePoint(0xF0140)
var GLYPH_CHEVRON_UP = String.fromCodePoint(0xF0143)

// ----------------------------------------------------------------- shared

function elide(text, limit) {
  var value = String(text || "").replace(/\s+/g, " ").trim()
  return value.length > limit ? value.substring(0, limit - 1) + "…" : value
}

function detail(label, value) {
  return { label: label, value: String(value || "") }
}

// A tool setting the panel can flip. The value is always what the tool last
// reported, never something the widget stores — nothing here owns a setting.
function toggle(key, label, description, value) {
  return { key: key, label: label, detail: description, value: value === true, busy: false }
}

// A toggle the user just flipped shows the new position and a busy marker until
// the tool confirms it, so the switch does not sit still under the click.
function applyPendingToggles(toggles, pending) {
  if (!pending) return toggles
  return toggles.map(function(entry) {
    if (pending[entry.key] === undefined) return entry
    return { key: entry.key, label: entry.label, detail: entry.detail, value: pending[entry.key] === true, busy: true }
  })
}

// ------------------------------------------------------------ Proton VPN

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
    ip: "",
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
    } else if (key === "ip" || key === "ip address") {
      result.ip = value
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
    toggle("kill-switch", "Kill switch",
      killSwitch !== "off" && killSwitch !== "standard"
        ? "Mode: " + killSwitch
        : "Cut traffic if the tunnel drops",
      killSwitch !== "off"),
    toggle("netshield", "NetShield",
      netshield !== "off" ? "Blocking: " + netshield : "Block ads, trackers, malware",
      netshield !== "off"),
    toggle("port-forwarding", "Port forwarding", "Open an inbound port for P2P",
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

  var rows = [detail("Server", status.server), detail("Location", protonLocation(status))]
  if (status.load !== "") rows.push(detail("Load", status.load))
  if (status.protocol !== "") rows.push(detail("Protocol", status.protocol))
  return rows.filter(function(row) { return row.value !== "" })
}

function favoriteCodes(raw) {
  var codes = []
  var parts = String(raw || "").split(",")
  for (var i = 0; i < parts.length; i++) {
    var code = parts[i].trim().toUpperCase()
    if (code !== "" && codes.indexOf(code) < 0) codes.push(code)
  }
  return codes
}

// Quick-connect rows above the country list. `args` is passed straight to
// `protonvpn connect`.
function protonQuickTargets() {
  return [
    { key: "fastest", label: "Fastest server", detail: "Best available worldwide", glyph: GLYPH_BOLT, args: [] },
    { key: "p2p", label: "P2P server", detail: "Fastest server that allows P2P", glyph: GLYPH_SWAP, args: ["--p2p"] },
    { key: "random", label: "Random server", detail: "Pick any available server", glyph: GLYPH_DICE, args: ["--random"] },
    { key: "securecore", label: "Secure Core", detail: "Route through a hardened entry", glyph: GLYPH_LOCK, args: ["--securecore"] }
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
      glyph: GLYPH_VPN,
      args: ["--country", country.code]
    }
    if (needle === "" && favorites.indexOf(country.code) >= 0) favored.push(target)
    else rest.push(target)
  }

  return favored.concat(rest)
}

// ---------------------------------------------------------------- OpenVPN

// `nmcli -t` escapes literal colons as "\:", so split on the first unescaped
// one rather than on every colon.
function splitNmcliLine(line) {
  var text = String(line || "")
  for (var i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue }
    if (text[i] === ":") return [unescapeNmcli(text.substring(0, i)), unescapeNmcli(text.substring(i + 1))]
  }
  return [unescapeNmcli(text), ""]
}

function unescapeNmcli(value) {
  return String(value || "").replace(/\\(.)/g, "$1")
}

// `nmcli -t -f NAME,UUID,TYPE,ACTIVE connection show` — one connection per
// line. Only the `vpn` type can be an OpenVPN profile; `wireguard` and plain
// devices are somebody else's business.
function parseNmcliConnections(raw) {
  var connections = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.trim() === "") continue

    var fields = []
    var rest = line
    for (var f = 0; f < 3; f++) {
      var pair = splitNmcliLine(rest)
      fields.push(pair[0])
      rest = pair[1]
    }
    fields.push(unescapeNmcli(rest))

    if (fields[2] !== "vpn") continue
    connections.push({ name: fields[0], uuid: fields[1], active: fields[3] === "yes" })
  }
  return connections
}

// `nmcli -t -f connection.uuid,vpn.service-type,vpn.data connection show <uuid>…`
// prints one blank-line-separated block per connection, each line prefixed
// with its field name. Returns { uuid: { serviceType, hasUsername } }.
function parseNmcliVpnDetails(raw) {
  var details = {}
  var current = null
  var lines = String(raw || "").split("\n")

  function flush() {
    if (current && current.uuid !== "") details[current.uuid] = current
    current = null
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") {
      flush()
      continue
    }

    var pair = splitNmcliLine(line)
    if (!current) current = { uuid: "", serviceType: "", hasUsername: false }

    if (pair[0] === "connection.uuid") current.uuid = pair[1]
    else if (pair[0] === "vpn.service-type") current.serviceType = pair[1]
    else if (pair[0] === "vpn.data") current.hasUsername = hasVpnUsername(pair[1])
  }
  flush()

  return details
}

// vpn.data is a comma-separated "key = value" list. OpenVPN's username lives
// there rather than in vpn.secrets, so `nmcli --ask` never prompts for it —
// a profile missing it authenticates as the empty user and is rejected.
function hasVpnUsername(data) {
  var entries = String(data || "").split(",")
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i].trim()
    if (entry.indexOf("username") !== 0) continue

    var value = entry.substring(entry.indexOf("=") + 1).trim()
    if (value !== "") return true
  }
  return false
}

function isOpenVpnService(serviceType) {
  return String(serviceType || "").toLowerCase().indexOf("openvpn") !== -1
}

function openVpnTargets(profiles) {
  var targets = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    targets.push({
      key: "profile:" + profile.uuid,
      label: profile.name,
      detail: profile.active
        ? "Connected"
        : (profile.hasUsername ? "NetworkManager profile" : "No username set"),
      glyph: GLYPH_LOCK,
      args: ["connection", "up", "uuid", profile.uuid],
      uuid: profile.uuid,
      hasUsername: profile.hasUsername
    })
  }
  return targets
}

function openVpnSummary(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i].name
  }
  return profiles.length === 0 ? "No profiles" : "Not connected"
}

function openVpnDetails(profiles) {
  var rows = []
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) rows.push(detail("Profile", profiles[i].name))
  }
  if (rows.length > 0) rows.push(detail("Managed by", "NetworkManager"))
  return rows
}

function activeOpenVpnProfile(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i]
  }
  return null
}

// ---------------------------------------------------------------- Mullvad

// `mullvad status -j` prints one JSON object. `state` is the tunnel state; the
// shape of `details` follows it — an object while connected, connecting or
// disconnected, a bare string ("reconnect") while disconnecting. Anything
// unparseable is treated as "no idea", not as disconnected.
function parseMullvadStatus(raw) {
  var result = {
    state: "",
    connected: false,
    blocked: false,
    relay: "",
    country: "",
    city: "",
    ip: "",
    endpoint: "",
    protocol: "",
    tunnelInterface: "",
    features: [],
    lockedDown: false,
    statusText: ""
  }

  var text = String(raw || "").trim()
  if (text === "") return result

  var payload = null
  try {
    payload = JSON.parse(text)
  } catch (error) {
    return result
  }
  if (!payload || typeof payload !== "object") return result

  result.state = String(payload.state || "")
  result.connected = result.state === "connected"
  result.blocked = result.state === "error"

  var details = payload.details
  if (details && typeof details === "object") {
    var location = details.location
    if (location && typeof location === "object") {
      result.relay = String(location.hostname || "")
      result.country = String(location.country || "")
      result.city = String(location.city || "")
      result.ip = String(location.ipv4 || location.ipv6 || "")
    }

    var endpoint = details.endpoint
    if (endpoint && typeof endpoint === "object") {
      result.endpoint = String(endpoint.address || "")
      result.protocol = String(endpoint.protocol || "").toUpperCase()
      result.tunnelInterface = String(endpoint.tunnel_interface || "")
    }

    // Only reported while down, and only then does it mean traffic is being
    // dropped right now. The lockdown *setting* is read separately.
    if (details.locked_down === true) result.lockedDown = true

    var indicators = details.feature_indicators
    if (indicators && indicators.length) {
      for (var i = 0; i < indicators.length; i++) result.features.push(mullvadFeatureLabel(indicators[i]))
    }
  }

  result.statusText = mullvadStateText(result)
  return result
}

// Feature indicators come back as CamelCase tags: "QuantumResistance".
function mullvadFeatureLabel(tag) {
  return String(tag || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
}

function mullvadStateText(status) {
  if (status.state === "connected") return "Connected"
  if (status.state === "connecting") return "Connecting"
  if (status.state === "disconnecting") return "Disconnecting"
  if (status.state === "error") return "Blocked"
  if (status.state === "disconnected") return "Disconnected"
  return "Unknown"
}

function mullvadLocation(status) {
  var parts = []
  if (status.city !== "") parts.push(status.city)
  if (status.country !== "") parts.push(status.country)
  return parts.join(", ")
}

function mullvadSummary(status) {
  var location = mullvadLocation(status)

  if (status.state === "connected") {
    if (location !== "" && status.relay !== "") return status.relay + " · " + location
    if (location !== "") return location
    if (status.relay !== "") return status.relay
    return "Connected"
  }
  if (status.state === "connecting") return location !== "" ? "Connecting to " + location + "…" : "Connecting…"
  if (status.state === "disconnecting") return "Disconnecting…"
  // Not a quieter kind of disconnected: nothing is leaving the machine at all.
  if (status.state === "error") return "Blocked — no traffic is leaving this machine"
  if (status.state === "disconnected") return status.lockedDown ? "Not connected · traffic blocked" : "Not connected"
  // No state yet: the first status call has not come back.
  return "Checking…"
}

// Lockdown gets no row of its own: the daemon already reports it as a feature
// indicator whenever it is on.
function mullvadDetails(status) {
  if (status.state !== "connected") return []

  var rows = [detail("Relay", status.relay), detail("Location", mullvadLocation(status))]
  if (status.endpoint !== "") {
    rows.push(detail("Endpoint", status.protocol !== "" ? status.endpoint + " · " + status.protocol : status.endpoint))
  }
  if (status.tunnelInterface !== "") rows.push(detail("Interface", status.tunnelInterface))
  if (status.features.length > 0) rows.push(detail("Features", status.features.join(", ")))
  return rows.filter(function(row) { return row.value !== "" })
}

// Counts a tab as one level and four spaces as the same, since the CLI indents
// with tabs but nothing promises it always will.
function mullvadIndentDepth(line) {
  var tabs = 0
  var spaces = 0
  for (var i = 0; i < line.length; i++) {
    if (line[i] === "\t") { tabs += 1; continue }
    if (line[i] === " ") { spaces += 1; continue }
    break
  }
  return tabs + Math.floor(spaces / 4)
}

// `mullvad relay list` nests three levels, and every level looks like
// "<name> (<code>)", so depth is what tells them apart:
//
//   Switzerland (ch)
//   \tZurich (zrh) @ 47.36667°N, 8.55000°W
//   \t\tch-zrh-wg-001 (185.156.46.146, …) - hosted by 31173 (rented)
//
// Only countries and cities are kept; individual relays are more choice than
// a bar popup wants to offer.
function parseMullvadRelays(raw) {
  var countries = []
  var current = null
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.trim() === "") continue

    var depth = mullvadIndentDepth(line)
    if (depth > 1) continue

    var match = line.trim().match(/^(.+?)\s+\(([A-Za-z]{2,3})\)/)
    if (!match) continue

    var name = match[1].trim()
    var code = match[2].toLowerCase()

    if (depth === 0) {
      if (code.length !== 2) continue
      current = { name: name, code: code.toUpperCase(), cities: [] }
      countries.push(current)
    } else if (current && code.length === 3) {
      current.cities.push({ name: name, code: code })
    }
  }
  return countries
}

// Mullvad has no "fastest server" verb — `connect` uses whatever constraint is
// stored — so the quick row is the widest constraint there is.
function mullvadQuickTargets() {
  return [
    { key: "any", label: "Any location", detail: "Let Mullvad pick the relay", glyph: GLYPH_BOLT, args: ["any"] }
  ]
}

// Favorites first, then the rest, filtering over the country name, its code,
// and its city names so "zurich" finds Switzerland.
function mullvadCountryTargets(countries, favorites, filter) {
  var needle = String(filter || "").trim().toLowerCase()
  var favored = []
  var rest = []

  for (var i = 0; i < countries.length; i++) {
    var country = countries[i]
    var cities = country.cities || []

    if (needle !== "") {
      var haystack = (country.name + " " + country.code + " " + cities.map(function(city) {
        return city.name + " " + city.code
      }).join(" ")).toLowerCase()
      if (haystack.indexOf(needle) < 0) continue
    }

    var target = {
      key: "country:" + country.code,
      label: country.name,
      detail: cities.length > 0 ? country.code + " · " + cities.length + (cities.length === 1 ? " city" : " cities") : country.code,
      glyph: GLYPH_VPN,
      args: [country.code.toLowerCase()]
    }
    if (needle === "" && favorites.indexOf(country.code) >= 0) favored.push(target)
    else rest.push(target)
  }

  return favored.concat(rest)
}

// Which row to tick. The relay hostname carries its country ("ch-zrh-wg-504"),
// which is exact; falling back to the country name covers the moment during a
// connect when the hostname is not reported yet.
function mullvadCurrentKey(status, countries) {
  if (status.state !== "connected" && status.state !== "connecting") return ""

  var hosted = String(status.relay || "").match(/^([a-z]{2})-/i)
  if (hosted) return "country:" + hosted[1].toUpperCase()

  var name = String(status.country || "").trim().toLowerCase()
  if (name === "") return ""
  for (var i = 0; i < countries.length; i++) {
    if (countries[i].name.toLowerCase() === name) return "country:" + countries[i].code
  }
  return ""
}

// The three switchable settings live behind three separate subcommands, so the
// backend asks for them in one shell and this reads whichever lines came back.
// Each is matched on its leading words rather than on line order:
//
//   Autoconnect: off
//   Block traffic when the VPN is disconnected: off
//   Local network sharing setting: block
function parseMullvadSettings(raw) {
  var settings = { autoconnect: false, lockdown: false, lan: false, loaded: false }
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    var separator = line.indexOf(":")
    if (separator < 0) continue

    var key = line.substring(0, separator).trim().toLowerCase()
    var value = line.substring(separator + 1).trim().toLowerCase()
    if (value === "") continue

    if (key === "autoconnect") {
      settings.autoconnect = value === "on"
      settings.loaded = true
    } else if (key.indexOf("block traffic") === 0) {
      settings.lockdown = value === "on"
      settings.loaded = true
    } else if (key.indexOf("local network sharing") === 0) {
      settings.lan = value === "allow"
      settings.loaded = true
    }
  }
  return settings
}

function mullvadToggles(settings) {
  if (!settings || !settings.loaded) return []

  return [
    toggle("autoconnect", "Connect on startup", "Up as soon as the daemon starts", settings.autoconnect),
    toggle("lockdown", "Lockdown mode", "No traffic at all while down", settings.lockdown),
    toggle("lan", "Allow local network", "Reach printers and NAS while up", settings.lan)
  ]
}

function mullvadToggleArgs(key, value) {
  if (key === "autoconnect") return ["auto-connect", "set", value ? "on" : "off"]
  if (key === "lockdown") return ["lockdown-mode", "set", value ? "on" : "off"]
  if (key === "lan") return ["lan", "set", value ? "allow" : "block"]
  return []
}
