.pragma library
.import "Shared.js" as Shared

// OpenVPN and WireGuard profiles, via `nmcli`. Parsing and row-building only —
// the process plumbing lives in NetworkManagerBackend.qml.

//
// OpenVPN, WireGuard and OpenConnect all live here, because on a desktop all
// three are NetworkManager profiles: same listing call, same teardown. What
// differs is how NetworkManager types them — OpenVPN and OpenConnect are `vpn`
// connections with a service-type plugin behind them, WireGuard is its own
// connection type with the keys in the profile.
//
// OpenConnect differs from the other two in one way that reaches this file: it
// cannot be brought up with `connection up` alone. Its cookie/gateway/gwcert/
// resolve secrets are all flagged not-saved, so every activation needs a
// secret agent to produce them, and the answer is a helper that runs the
// openconnect auth dialog. That is why an OpenConnect target carries a whole
// command rather than nmcli arguments.

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
// with its field name. Returns { uuid: { serviceType, hasUsername, gateway } }.
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
    if (!current) current = { uuid: "", serviceType: "", hasUsername: false, gateway: "" }

    if (pair[0] === "connection.uuid") current.uuid = pair[1]
    else if (pair[0] === "vpn.service-type") current.serviceType = pair[1]
    else if (pair[0] === "vpn.data") {
      current.hasUsername = hasVpnUsername(pair[1])
      current.gateway = vpnDataValue(pair[1], "gateway")
    }
  }
  flush()

  return details
}

// One "key = value" out of vpn.data, matched on the whole key so that
// `gateway-flags` is not mistaken for `gateway` — OpenConnect profiles carry
// both, and the flags entry sorts first.
function vpnDataValue(data, wanted) {
  var entries = String(data || "").split(",")
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var eq = entry.indexOf("=")
    if (eq === -1) continue
    if (entry.substring(0, eq).trim() !== wanted) continue
    return entry.substring(eq + 1).trim()
  }
  return ""
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

// "openconnect" does not contain "openvpn", so the two checks cannot both
// claim the same profile.
function isOpenConnectService(serviceType) {
  return String(serviceType || "").toLowerCase().indexOf("openconnect") !== -1
}

function isWireGuard(profile) {
  return profile && profile.kind === "wireguard"
}

function isOpenConnect(profile) {
  return profile && profile.kind === "openconnect"
}

// A username is an OpenVPN concern only. WireGuard keeps its keys in the
// profile, and OpenConnect asks the gateway who you are as part of its own
// authentication, so neither can be missing one.
function needsUsername(profile) {
  return !isWireGuard(profile) && !isOpenConnect(profile)
}

function nmKindLabel(profile) {
  if (isWireGuard(profile)) return "WireGuard"
  if (isOpenConnect(profile)) return "OpenConnect"
  return "OpenVPN"
}

// The glyph carries the kind, since the rows otherwise look identical and the
// three behave differently the moment credentials come up.
//
// `authScript` is the openconnect helper's absolute path, which only the
// backend knows. An OpenConnect target gets a `command` — a whole argv — where
// the others get `args` to hand to nmcli, because its activation is not an
// nmcli call. Without the helper an OpenConnect row is still listed and still
// says what it is, but has nothing to run.
function nmTargets(profiles, authScript) {
  var targets = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    var wireguard = isWireGuard(profile)
    var openconnect = isOpenConnect(profile)

    var glyph = Shared.GLYPH_LOCK
    if (wireguard) glyph = Shared.GLYPH_SHIELD
    else if (openconnect) glyph = Shared.GLYPH_SHIELD_LOCK

    var target = {
      key: "profile:" + profile.uuid,
      label: profile.name,
      detail: profile.active
        ? "Connected"
        // Only OpenVPN can be missing a username: WireGuard keeps its keys in
        // the profile, and OpenConnect settles identity with the gateway, so
        // neither has anything for the user to have left out.
        : (!needsUsername(profile) || profile.hasUsername
            ? nmKindLabel(profile) + " profile"
            : "No username set"),
      glyph: glyph,
      args: ["connection", "up", "uuid", profile.uuid],
      uuid: profile.uuid,
      kind: profile.kind,
      hasUsername: profile.hasUsername,
      gateway: profile.gateway || ""
    }

    if (openconnect && String(authScript || "") !== "") {
      target.command = [String(authScript), profile.uuid]
    }

    targets.push(target)
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
    // Which gateway an OpenConnect profile reached, since a company commonly
    // has several and the profile name rarely says which one.
    if (isOpenConnect(profiles[i]) && profiles[i].gateway) {
      rows.push(Shared.detail("Gateway", profiles[i].gateway))
    }
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
