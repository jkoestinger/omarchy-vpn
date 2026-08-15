.pragma library
.import "Shared.js" as Shared

// Mullvad, via the `mullvad` CLI. Parsing and row-building only — the process
// plumbing lives in MullvadBackend.qml.

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

  var rows = [Shared.detail("Relay", status.relay), Shared.detail("Location", mullvadLocation(status))]
  if (status.endpoint !== "") {
    rows.push(Shared.detail("Endpoint", status.protocol !== "" ? status.endpoint + " · " + status.protocol : status.endpoint))
  }
  if (status.tunnelInterface !== "") rows.push(Shared.detail("Interface", status.tunnelInterface))
  if (status.features.length > 0) rows.push(Shared.detail("Features", status.features.join(", ")))
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
    { key: "any", label: "Any location", detail: "Let Mullvad pick the relay", glyph: Shared.GLYPH_BOLT, args: ["any"] }
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
      glyph: Shared.GLYPH_VPN,
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
//
// One shell means one exit code — the last subcommand's — so a subcommand that
// failed or that this version of the CLI does not have leaves no line and no
// error. `seen` is which answers actually arrived: an unanswered setting is
// unknown, not off. Reporting lockdown mode as off while it is on is the one
// mistake a VPN widget must not make.
function parseMullvadSettings(raw) {
  var settings = { autoconnect: false, lockdown: false, lan: false, seen: {}, loaded: false }
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
      settings.seen.autoconnect = true
    } else if (key.indexOf("block traffic") === 0) {
      settings.lockdown = value === "on"
      settings.seen.lockdown = true
    } else if (key.indexOf("local network sharing") === 0) {
      settings.lan = value === "allow"
      settings.seen.lan = true
    }
  }

  settings.loaded = settings.seen.autoconnect === true
    || settings.seen.lockdown === true
    || settings.seen.lan === true
  return settings
}

// A switch is drawn only for a setting the daemon answered for. A partial read
// shows fewer switches rather than a full row of confident wrong ones.
function mullvadToggles(settings) {
  if (!settings || !settings.loaded) return []

  var seen = settings.seen || {}
  var toggles = []
  if (seen.autoconnect === true) {
    toggles.push(Shared.toggle("autoconnect", "Connect on startup", "Up as soon as the daemon starts", settings.autoconnect))
  }
  if (seen.lockdown === true) {
    toggles.push(Shared.toggle("lockdown", "Lockdown mode", "No traffic at all while down", settings.lockdown))
  }
  if (seen.lan === true) {
    toggles.push(Shared.toggle("lan", "Allow local network", "Reach printers and NAS while up", settings.lan))
  }
  return toggles
}

function mullvadToggleArgs(key, value) {
  if (key === "autoconnect") return ["auto-connect", "set", value ? "on" : "off"]
  if (key === "lockdown") return ["lockdown-mode", "set", value ? "on" : "off"]
  if (key === "lan") return ["lan", "set", value ? "allow" : "block"]
  return []
}
