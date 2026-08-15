.pragma library
.import "Shared.js" as Shared

// OpenVPN and WireGuard profiles, via `nmcli`. Parsing and row-building only —
// the process plumbing lives in NetworkManagerBackend.qml.

//
// OpenVPN and WireGuard both live here, because on a desktop both are
// NetworkManager profiles: same listing call, same `connection up` verb, same
// teardown. What differs is how NetworkManager types them — OpenVPN is a `vpn`
// connection with a service-type plugin behind it, WireGuard is its own
// connection type with the keys in the profile.

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

// Generated on the fly for a device someone else brought up, rather than a
// profile on disk. Empty means the field was never asked for: nmcli refuses a
// listing that names a field it does not know, so an nmcli too old for
// FILENAME is retried without it — see NetworkManagerBackend. Such a
// connection is kept, since a stray row beats a backend that lists nothing.
function isVolatileConnection(filename) {
  return String(filename || "").indexOf("/run/") === 0
}

// `nmcli -t -f NAME,UUID,TYPE,ACTIVE,FILENAME connection show` — one connection
// per line. Two types are tunnels: `vpn` (an OpenVPN profile, or another
// plugin's, which the second pass sorts out) and `wireguard`. Ethernet, wifi,
// bridges and the rest are somebody else's business.
//
// FILENAME is what keeps other tools' tunnels out. When something brings up a
// WireGuard interface itself — Mullvad's `wg0-mullvad`, say — NetworkManager
// adopts the device and generates a volatile connection for it under
// `/run/NetworkManager/`. Listing that would put the same tunnel on two chips,
// and taking it down through nmcli would yank it out from under the tool that
// owns it. Profiles the user actually imported are stored under `/etc`.
function parseNmcliConnections(raw) {
  var connections = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.trim() === "") continue

    var fields = []
    var rest = line
    for (var f = 0; f < 4; f++) {
      var pair = splitNmcliLine(rest)
      fields.push(pair[0])
      rest = pair[1]
    }
    fields.push(unescapeNmcli(rest))

    if (fields[2] !== "vpn" && fields[2] !== "wireguard") continue
    if (isVolatileConnection(fields[4])) continue
    connections.push({
      name: fields[0],
      uuid: fields[1],
      // "vpn" here means "needs the second pass to say which plugin".
      kind: fields[2] === "wireguard" ? "wireguard" : "vpn",
      active: fields[3] === "yes"
    })
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

function isWireGuard(profile) {
  return profile && profile.kind === "wireguard"
}

function nmKindLabel(profile) {
  return isWireGuard(profile) ? "WireGuard" : "OpenVPN"
}

// The glyph carries the kind, since the rows otherwise look identical and the
// two behave differently the moment credentials come up.
function nmTargets(profiles) {
  var targets = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    var wireguard = isWireGuard(profile)

    targets.push({
      key: "profile:" + profile.uuid,
      label: profile.name,
      detail: profile.active
        ? "Connected"
        // Only OpenVPN can be missing a username: WireGuard keeps its keys in
        // the profile, so there is nothing for the user to have left out.
        : (wireguard || profile.hasUsername ? nmKindLabel(profile) + " profile" : "No username set"),
      glyph: wireguard ? Shared.GLYPH_SHIELD : Shared.GLYPH_LOCK,
      args: ["connection", "up", "uuid", profile.uuid],
      uuid: profile.uuid,
      kind: profile.kind,
      hasUsername: profile.hasUsername
    })
  }
  return targets
}

function nmSummary(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i].name
  }
  return profiles.length === 0 ? "No profiles" : "Not connected"
}

function nmDetails(profiles) {
  var rows = []
  for (var i = 0; i < profiles.length; i++) {
    if (!profiles[i].active) continue
    rows.push(Shared.detail("Profile", profiles[i].name))
    rows.push(Shared.detail("Type", nmKindLabel(profiles[i])))
  }
  if (rows.length > 0) rows.push(Shared.detail("Managed by", "NetworkManager"))
  return rows
}

function activeNmProfile(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i]
  }
  return null
}
