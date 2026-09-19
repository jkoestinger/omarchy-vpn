.pragma library
.import "Shared.js" as Shared

// OpenVPN, WireGuard, OpenConnect, VPNC and L2TP/IPsec profiles, via `nmcli`.
// Parsing and row-building only — the process plumbing lives in
// NetworkManagerBackend.qml.

//
// All five live here because on a desktop they are NetworkManager profiles:
// same listing call, same activation and teardown. What differs is how
// NetworkManager types them — OpenVPN, OpenConnect, VPNC and L2TP are `vpn`
// connections with a service-type plugin behind them, while WireGuard is its
// own connection type with the keys in the profile.
//
// OpenConnect differs from the other four in one way that reaches this file: it
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
// with its field name. Returns
// { uuid: { serviceType, hasUsername, gateway, connectionType } }.
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
    if (!current) current = { uuid: "", serviceType: "", hasUsername: false, gateway: "", connectionType: "" }

    if (pair[0] === "connection.uuid") current.uuid = pair[1]
    else if (pair[0] === "vpn.service-type") current.serviceType = pair[1]
    else if (pair[0] === "vpn.data") {
      current.hasUsername = hasVpnUsername(pair[1])
      current.connectionType = vpnDataValue(pair[1], "connection-type")
      // OpenConnect calls this `gateway`; VPNC inherited the spelling used by
      // vpnc.conf. Keeping one field downstream lets the detail row stay blind
      // to the plugin that supplied it.
      current.gateway = vpnDataValue(pair[1], "gateway")
        || vpnDataValue(pair[1], "IPSec gateway")
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

// vpn.data is a comma-separated "key = value" list. OpenVPN calls the identity
// `username`; VPNC calls it `Xauth username`; L2TP calls it `user`. All three
// live outside vpn.secrets, so `nmcli --ask` never prompts for any of them — a
// profile missing one authenticates as the empty user and is rejected.
function hasVpnUsername(data) {
  var entries = String(data || "").split(",")
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i].trim()
    var eq = entry.indexOf("=")
    if (eq === -1) continue
    var key = entry.substring(0, eq).trim().toLowerCase()
    if (key !== "username" && key !== "xauth username" && key !== "user") continue

    var value = entry.substring(eq + 1).trim()
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

function isVpncService(serviceType) {
  return String(serviceType || "").toLowerCase().indexOf("networkmanager.vpnc") !== -1
}

function isL2tpService(serviceType) {
  return String(serviceType || "").toLowerCase().indexOf("networkmanager.l2tp") !== -1
}

function isWireGuard(profile) {
  return profile && profile.kind === "wireguard"
}

function isOpenConnect(profile) {
  return profile && profile.kind === "openconnect"
}

function isVpnc(profile) {
  return profile && profile.kind === "vpnc"
}

function isL2tp(profile) {
  return profile && profile.kind === "l2tp"
}

// NetworkManager's OpenVPN plugin records the auth mode in `connection-type`:
// `tls` authenticates with a certificate and key alone, and `static-key` with a
// pre-shared key, so neither reads a username — only `password` and
// `password-tls` do. An Azure point-to-site certificate profile imports as
// `tls`, and calling that one "no username set" blocks a connection that would
// have worked.
function isCertificateOnlyOpenVpn(profile) {
  var type = String((profile && profile.connectionType) || "").toLowerCase()
  return type === "tls" || type === "static-key"
}

// A username is an OpenVPN, VPNC and L2TP concern. WireGuard keeps its keys in
// the profile, and OpenConnect asks the gateway who you are as part of its own
// authentication, so neither can be missing one.
function needsUsername(profile) {
  return !isWireGuard(profile) && !isOpenConnect(profile)
    && !isCertificateOnlyOpenVpn(profile)
}

function usernameSetting(profile) {
  if (isVpnc(profile)) return "Xauth username"
  if (isL2tp(profile)) return "user"
  return "username"
}

function nmKindLabel(profile) {
  if (isWireGuard(profile)) return "WireGuard"
  if (isOpenConnect(profile)) return "OpenConnect"
  if (isVpnc(profile)) return "VPNC"
  if (isL2tp(profile)) return "L2TP"
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
function nmTargets(profiles, authScript, addresses) {
  var targets = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    var wireguard = isWireGuard(profile)
    var openconnect = isOpenConnect(profile)
    var vpnc = isVpnc(profile)
    var l2tp = isL2tp(profile)

    var glyph = Shared.GLYPH_LOCK
    if (wireguard) glyph = Shared.GLYPH_SHIELD
    else if (openconnect || vpnc || l2tp) glyph = Shared.GLYPH_SHIELD_LOCK

    var target = {
      key: "profile:" + profile.uuid,
      label: profile.name,
      active: profile.active === true,
      detail: nmProfileDetail(profile, addresses),
      glyph: glyph,
      args: ["connection", "up", "uuid", profile.uuid],
      uuid: profile.uuid,
      kind: profile.kind,
      hasUsername: profile.hasUsername,
      connectionType: profile.connectionType || "",
      gateway: profile.gateway || ""
    }

    if (openconnect && String(authScript || "") !== "") {
      target.command = [String(authScript), profile.uuid]
    }

    targets.push(target)
  }
  return targets
}

// Each plugin has its own way in, and naming one that is not installed sends
// people after a package they do not need — the line named OpenVPN and
// WireGuard whatever was actually installed. OpenVPN and WireGuard import the
// file someone is handed; an IPsec gateway arrives as a set of values in an
// email rather than a file, so those profiles are built field by field. The
// key names are the ones NetworkManager itself stores, which is why they are
// spelled inconsistently.
function nmEmptyText(tools) {
  var available = tools || {}
  var ways = []

  if (available.openvpn) {
    ways.push("nmcli connection import type openvpn file <config.ovpn>")
  }
  if (available.wireguard) {
    ways.push("nmcli connection import type wireguard file <config.conf>")
  }
  if (available.openconnect) {
    ways.push("nmcli connection add type vpn vpn-type openconnect con-name <name>"
      + " -- vpn.data \"gateway = <host>\"")
  }
  if (available.vpnc) {
    ways.push("nmcli connection add type vpn vpn-type vpnc con-name <name>"
      + " -- vpn.data \"IPSec gateway = <host>, IPSec ID = <group>, Xauth username = <you>\"")
  }
  if (available.l2tp) {
    ways.push("nmcli connection add type vpn vpn-type l2tp con-name <name>"
      + " -- vpn.data \"gateway = <host>, user = <you>, ipsec-enabled = yes\"")
  }

  if (ways.length === 0) return "No profiles yet."
  return "No profiles yet. Create one with: " + ways.join(" — or: ")
}

function nmSummary(profiles) {
  var names = []
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) names.push(profiles[i].name)
  }
  if (names.length > 0) return names.sort().join(" + ")
  return profiles.length === 0 ? "No profiles" : "Not connected"
}

function nmConnectionCount(profiles) {
  var count = profiles.filter(function(profile) { return profile.active }).length
  return count === 0 ? "Not connected" : count + (count === 1 ? " profile connected" : " profiles connected")
}

function nmProfileDetail(profile, addresses) {
  var text = nmKindLabel(profile)
  var ips = addresses && addresses[profile.uuid] || []
  if (profile.active && ips.length) text += "\n" + ips.join("\n")
  if (!profile.active && needsUsername(profile) && profile.hasUsername === false) text += "\nNo username set"
  if (profile.gateway) text += "\nGateway: " + profile.gateway
  return text
}

// Read runtime addresses, never configured AllowedIPs (those are remote routes).
// GENERAL.UUID starts a profile block; IPv6 colons use nmcli's normal escaping.
function parseNmAddresses(raw) {
  var result = {}
  var uuid = ""
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var pair = splitNmcliLine(lines[i].trim())
    if (pair[0] === "GENERAL.UUID") {
      uuid = pair[1]
      if (uuid) result[uuid] = []
    } else if (uuid && /^IP[46]\.ADDRESS(?:\[\d+\])?$/.test(pair[0]) && pair[1] && pair[1] !== "--") {
      if (result[uuid].indexOf(pair[1]) === -1) result[uuid].push(pair[1])
    }
  }
  return result
}

function nmAddressCommand(profiles) {
  var args = ["nmcli", "-t", "-f", "GENERAL.UUID,IP4.ADDRESS,IP6.ADDRESS", "connection", "show"]
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) args.push("uuid", profiles[i].uuid)
  }
  return args.length === 6 ? [] : args
}

function activeNmProfile(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i]
  }
  return null
}

// Activation never includes a teardown: routing policy belongs to each profile.
function nmActivationCommand(target) {
  if (target && target.command) return target.command
  return ["nmcli"].concat((target && target.args) || [])
}

// Empty UUID means the explicit disconnect-all action. Only listed active VPN
// profiles are included, never Wi-Fi, Tailscale, or another backend's tunnels.
function nmDisconnectArgs(profiles, uuid) {
  var args = ["connection", "down"]
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active && (!uuid || profiles[i].uuid === uuid)) {
      args.push("uuid", profiles[i].uuid)
    }
  }
  return args.length === 2 ? [] : args
}

// nmcli defaults to active-first ordering, which moves a row under the pointer
// when it is toggled. Keep a deterministic name/UUID order regardless of status.
function nmOrderedProfiles(profiles) {
  return profiles.slice().sort(function(a, b) {
    var left = String(a.name).toLowerCase()
    var right = String(b.name).toLowerCase()
    if (left < right) return -1
    if (left > right) return 1
    return a.uuid < b.uuid ? -1 : (a.uuid > b.uuid ? 1 : 0)
  })
}
