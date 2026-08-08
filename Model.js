.pragma library

// Nerd Font glyphs are built from codepoints instead of raw characters so the
// file survives editing tools that mangle multi-byte sequences.
var GLYPH_VPN = String.fromCodePoint(0xF0582)
var GLYPH_CHECK = String.fromCodePoint(0xF012C)
var GLYPH_LOCK = String.fromCodePoint(0xF033E)
var GLYPH_BOLT = String.fromCodePoint(0xF04C5)
var GLYPH_DICE = String.fromCodePoint(0xF01D5)

// ----------------------------------------------------------------- shared

function elide(text, limit) {
  var value = String(text || "").replace(/\s+/g, " ").trim()
  return value.length > limit ? value.substring(0, limit - 1) + "…" : value
}

function detail(label, value) {
  return { label: label, value: String(value || "") }
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
