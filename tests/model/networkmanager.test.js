// OpenVPN, WireGuard, OpenConnect, VPNC and L2TP profiles: how `nmcli` formats
// what it prints, and which rows survive the filtering.
const { test, eq, Shared, NetworkManager } = require("../harness.js")

test("splitNmcliLine splits on the first unescaped colon", () => {
  eq(NetworkManager.splitNmcliLine("home\\:vpn:uuid-1"), ["home:vpn", "uuid-1"])
  eq(NetworkManager.splitNmcliLine("plain"), ["plain", ""])
})

test("parseNmcliConnections keeps only tunnels", () => {
  eq(NetworkManager.parseNmcliConnections([
    "Work VPN:uuid-1:vpn:yes:/etc/NetworkManager/system-connections/work.nmconnection",
    "Home WG:uuid-2:wireguard:no:/etc/NetworkManager/system-connections/home.nmconnection",
    "Wired:uuid-3:ethernet:yes:/etc/NetworkManager/system-connections/wired.nmconnection",
    ""
  ].join("\n")), [
    { name: "Work VPN", uuid: "uuid-1", kind: "vpn", active: true },
    { name: "Home WG", uuid: "uuid-2", kind: "wireguard", active: false }
  ])
})

test("parseNmcliConnections drops another tool's volatile connection", () => {
  // Mullvad brings up wg0-mullvad itself; NetworkManager adopts the device and
  // generates a profile under /run. Listing it would put one tunnel on two
  // chips and let nmcli yank it out from under the tool that owns it.
  eq(NetworkManager.parseNmcliConnections(
    "wg0-mullvad:uuid-9:wireguard:yes:/run/NetworkManager/system-connections/wg0-mullvad.nmconnection"
  ), [])
})

test("parseNmcliConnections keeps rows from an nmcli with no FILENAME field", () => {
  // The older-nmcli fallback: the field is dropped from the query and the
  // connection is kept, since a stray row beats a backend that lists nothing.
  eq(NetworkManager.parseNmcliConnections("Work VPN:uuid-1:vpn:yes"), [
    { name: "Work VPN", uuid: "uuid-1", kind: "vpn", active: true }
  ])
})

test("parseNmcliVpnDetails reads one block per connection", () => {
  const details = NetworkManager.parseNmcliVpnDetails([
    "connection.uuid:uuid-1",
    "vpn.service-type:org.freedesktop.NetworkManager.openvpn",
    "vpn.data:username = alice, comp-lzo = adaptive",
    "",
    "connection.uuid:uuid-2",
    "vpn.service-type:org.freedesktop.NetworkManager.fortisslvpn",
    "vpn.data:comp-lzo = adaptive"
  ].join("\n"))
  eq(Object.keys(details).sort(), ["uuid-1", "uuid-2"])
  eq(details["uuid-1"].hasUsername, true)
  eq(NetworkManager.isOpenVpnService(details["uuid-1"].serviceType), true)
  eq(details["uuid-2"].hasUsername, false)
  eq(NetworkManager.isOpenVpnService(details["uuid-2"].serviceType), false)
})

test("hasVpnUsername ignores an empty username", () => {
  eq(NetworkManager.hasVpnUsername("username = alice"), true)
  eq(NetworkManager.hasVpnUsername("Xauth username = alice"), true)
  eq(NetworkManager.hasVpnUsername("username = "), false)
  eq(NetworkManager.hasVpnUsername("Xauth username = "), false)
  eq(NetworkManager.hasVpnUsername("comp-lzo = adaptive"), false)
  eq(NetworkManager.hasVpnUsername(""), false)
})

// Real `nmcli -t -f connection.uuid,vpn.service-type,vpn.data` output for an
// Azure point-to-site profile imported from the gateway's vpnconfig_cert.ovpn.
// Certificate authentication, so there is no username anywhere in vpn.data.
const AZURE_CERT_DETAILS = [
  "connection.uuid:0b7f2c31-9d44-4a1e-8c66-2f5b9a0d1e73",
  "vpn.service-type:org.freedesktop.NetworkManager.openvpn",
  "vpn.data:auth = SHA256, ca = /home/user/.local/share/networkmanagement/certificates/nm-openvpn/azure-p2s-ca.pem, cert = /home/user/.local/share/networkmanagement/certificates/nm-openvpn/azure-p2s-cert.pem, challenge-response-flags = 2, cipher = AES-256-GCM, connection-type = tls, data-ciphers = AES-256-GCM:AES-128-GCM:AES-256-CBC, dev = tun, key = /home/user/.local/share/networkmanagement/certificates/nm-openvpn/azure-p2s-key.pem, proto-tcp = yes, remote = azuregateway-1a2b3c4d-5e6f-4718-9abc-def012345678-0123456789ab.vpn.azure.com:443, remote-cert-tls = server, ta = /home/user/.local/share/networkmanagement/certificates/nm-openvpn/azure-p2s-tls-auth.pem, ta-dir = 1, tls-version-min = 1.2, verify-x509-name = name:1a2b3c4d-5e6f-4718-9abc-def012345678.vpn.azure.com"
].join("\n")

test("parseNmcliVpnDetails reads the OpenVPN auth mode", () => {
  const detail = NetworkManager.parseNmcliVpnDetails(AZURE_CERT_DETAILS)["0b7f2c31-9d44-4a1e-8c66-2f5b9a0d1e73"]
  eq(detail.connectionType, "tls")
  eq(detail.hasUsername, false)
})

test("a certificate-only OpenVPN profile is not missing a username", () => {
  // `tls` and `static-key` authenticate without one; only `password` and
  // `password-tls` read a username, so those are the two that can lack it.
  eq(NetworkManager.needsUsername({ kind: "vpn", connectionType: "tls" }), false)
  eq(NetworkManager.needsUsername({ kind: "vpn", connectionType: "static-key" }), false)
  eq(NetworkManager.needsUsername({ kind: "vpn", connectionType: "password" }), true)
  eq(NetworkManager.needsUsername({ kind: "vpn", connectionType: "password-tls" }), true)
  // A profile whose auth mode never got read stays subject to the check.
  eq(NetworkManager.needsUsername({ kind: "vpn" }), true)
})

test("nmTargets shows certificate-only profiles as disconnected without a username warning", () => {
  const targets = NetworkManager.nmTargets([
    { name: "azure-p2s", uuid: "uuid-tls", kind: "vpn", active: false, hasUsername: false, connectionType: "tls" }
  ])
  eq(targets[0].detail, "OpenVPN")
  eq(targets[0].connectionType, "tls")
})

test("nmTargets flags an OpenVPN profile with no username", () => {
  const targets = NetworkManager.nmTargets([
    { name: "Work", uuid: "uuid-1", kind: "vpn", active: false, hasUsername: false },
    { name: "Home", uuid: "uuid-2", kind: "wireguard", active: false },
    { name: "Live", uuid: "uuid-3", kind: "vpn", active: true, hasUsername: true }
  ])
  eq(targets[0].detail, "OpenVPN\nNo username set")
  // WireGuard keeps its keys in the profile, so there is nothing to leave out.
  eq(targets[1].detail, "WireGuard")
  eq(targets[2].detail, "OpenVPN")
  eq(targets[0].args, ["connection", "up", "uuid", "uuid-1"])
})

// ------------------------------------------------------------- OpenConnect

// Real `nmcli -t -f connection.uuid,vpn.service-type,vpn.data connection show`
// output for an AnyConnect profile. Note `gateway-flags` sorts before
// `gateway`, and the four not-saved flags that are the whole reason this kind
// cannot be brought up with `connection up` alone.
const OPENCONNECT_DETAILS = [
  "connection.uuid:uuid-oc",
  "vpn.service-type:org.freedesktop.NetworkManager.openconnect",
  "vpn.data:authtype = password, cookie-flags = 2, gateway = vpn.example.com, gateway-flags = 2, gwcert-flags = 2, protocol = anyconnect, resolve-flags = 2",
  ""
].join("\n")

test("isOpenConnectService tells the plugins apart", () => {
  eq(NetworkManager.isOpenConnectService("org.freedesktop.NetworkManager.openconnect"), true)
  eq(NetworkManager.isOpenConnectService("org.freedesktop.NetworkManager.openvpn"), false)
  eq(NetworkManager.isOpenConnectService(""), false)
  // Neither name contains the other, so no profile can answer to both.
  eq(NetworkManager.isOpenVpnService("org.freedesktop.NetworkManager.openconnect"), false)
})

test("parseNmcliVpnDetails reads an OpenConnect profile's gateway", () => {
  const details = NetworkManager.parseNmcliVpnDetails(OPENCONNECT_DETAILS)
  eq(NetworkManager.isOpenConnectService(details["uuid-oc"].serviceType), true)
  eq(details["uuid-oc"].gateway, "vpn.example.com")
})

// `gateway-flags` appears first in vpn.data and starts with the same text, so a
// prefix match would return "2" and the panel would name the gateway as a
// number.
test("vpnDataValue matches the whole key, not a prefix", () => {
  eq(NetworkManager.vpnDataValue("gateway-flags = 2, gateway = vpn.example.com", "gateway"), "vpn.example.com")
  eq(NetworkManager.vpnDataValue("gateway-flags = 2", "gateway"), "")
  eq(NetworkManager.vpnDataValue("", "gateway"), "")
})

test("nmKindLabel names all five kinds", () => {
  eq(NetworkManager.nmKindLabel({ kind: "wireguard" }), "WireGuard")
  eq(NetworkManager.nmKindLabel({ kind: "openconnect" }), "OpenConnect")
  eq(NetworkManager.nmKindLabel({ kind: "vpnc" }), "VPNC")
  eq(NetworkManager.nmKindLabel({ kind: "l2tp" }), "L2TP")
  eq(NetworkManager.nmKindLabel({ kind: "vpn" }), "OpenVPN")
})

// A username is an OpenVPN concern. OpenConnect settles identity with the
// gateway during its own authentication, so demanding one would block a
// profile that is perfectly connectable.
test("nmTargets never asks an OpenConnect profile for a username", () => {
  const targets = NetworkManager.nmTargets([
    { name: "Work", uuid: "uuid-oc", kind: "openconnect", active: false, hasUsername: false }
  ], "/plugins/vpn/bin/omarchy-openconnect-auth")
  eq(targets[0].detail, "OpenConnect")
  eq(targets[0].glyph, Shared.GLYPH_SHIELD_LOCK)
})

// Its activation is not an nmcli call, so it carries a whole command. The other
// kinds must keep handing nmcli arguments.
test("nmTargets gives an OpenConnect target the helper as its command", () => {
  const targets = NetworkManager.nmTargets([
    { name: "Work", uuid: "uuid-oc", kind: "openconnect", active: false, gateway: "vpn.example.com" },
    { name: "Home", uuid: "uuid-wg", kind: "wireguard", active: false }
  ], "/plugins/vpn/bin/omarchy-openconnect-auth")
  eq(targets[0].command, ["/plugins/vpn/bin/omarchy-openconnect-auth", "uuid-oc"])
  eq(targets[0].gateway, "vpn.example.com")
  eq(targets[1].command, undefined)
  eq(targets[1].args, ["connection", "up", "uuid", "uuid-wg"])
})

// Without the helper the row is still listed and still says what it is; it
// simply has nothing to run, which the backend checks before connecting.
test("nmTargets omits the command when the helper is unknown", () => {
  const targets = NetworkManager.nmTargets([
    { name: "Work", uuid: "uuid-oc", kind: "openconnect", active: false }
  ])
  eq(targets[0].command, undefined)
  eq(targets[0].detail, "OpenConnect")
})

test("nmTargets names the gateway for a live OpenConnect tunnel", () => {
  const rows = NetworkManager.nmTargets([
    { name: "Work", uuid: "uuid-oc", kind: "openconnect", active: true, gateway: "vpn.example.com" }
  ])
  eq(rows.length, 1)
  eq(rows[0].detail.includes("OpenConnect"), true)
  eq(rows[0].detail.includes("Gateway: vpn.example.com"), true)
})

// OpenVPN and WireGuard have no gateway field, and an empty row would read as
// a missing value rather than an inapplicable one.
test("nmTargets adds no gateway row for the other kinds", () => {
  const rows = NetworkManager.nmTargets([
    { name: "Home", uuid: "uuid-wg", kind: "wireguard", active: true }
  ])
  eq(rows.length, 1)
  eq(rows[0].label, "Home")
  eq(rows[0].detail.includes("Gateway:"), false)
})

// -------------------------------------------------------------------- VPNC

// Real `nmcli -t -f connection.uuid,vpn.service-type,vpn.data connection show`
// shape for a NetworkManager VPNC profile. VPNC's identity and gateway keys
// deliberately retain the spelling used by vpnc.conf rather than OpenVPN's.
const VPNC_DETAILS = [
  "connection.uuid:uuid-vpnc",
  "vpn.service-type:org.freedesktop.NetworkManager.vpnc",
  "vpn.data:IKE DH Group = dh2, IPSec ID = staff, IPSec gateway = vpn.example.com, IPSec secret-flags = 0, NAT Traversal Mode = natt, Vendor = cisco, Xauth password-flags = 0, Xauth username = alice",
  ""
].join("\n")

test("isVpncService tells VPNC from the other NetworkManager plugins", () => {
  eq(NetworkManager.isVpncService("org.freedesktop.NetworkManager.vpnc"), true)
  eq(NetworkManager.isVpncService("org.freedesktop.NetworkManager.openvpn"), false)
  eq(NetworkManager.isVpncService("org.freedesktop.NetworkManager.openconnect"), false)
  eq(NetworkManager.isVpncService(""), false)
})

test("parseNmcliVpnDetails reads VPNC identity and gateway", () => {
  const detail = NetworkManager.parseNmcliVpnDetails(VPNC_DETAILS)["uuid-vpnc"]
  eq(detail.hasUsername, true)
  eq(detail.gateway, "vpn.example.com")
})

test("nmTargets presents VPNC as an ordinary NetworkManager profile", () => {
  const targets = NetworkManager.nmTargets([
    { name: "Campus", uuid: "uuid-vpnc", kind: "vpnc", active: false, hasUsername: true, gateway: "vpn.example.com" }
  ])
  eq(targets[0].detail, "VPNC\nGateway: vpn.example.com")
  eq(targets[0].glyph, Shared.GLYPH_SHIELD_LOCK)
  eq(targets[0].args, ["connection", "up", "uuid", "uuid-vpnc"])
  eq(targets[0].command, undefined)
  eq(NetworkManager.usernameSetting(targets[0]), "Xauth username")
})

test("nmTargets names a live VPNC tunnel and its gateway", () => {
  const rows = NetworkManager.nmTargets([
    { name: "Campus", uuid: "uuid-vpnc", kind: "vpnc", active: true, gateway: "vpn.example.com" }
  ])
  eq(rows.length, 1)
  eq(rows[0].detail.includes("VPNC"), true)
  eq(rows[0].detail.includes("Gateway: vpn.example.com"), true)
})

// Taken from a working NetworkManager-l2tp profile against an L2TP/IPsec
// gateway. The identity key is `user`, not OpenVPN's `username` or VPNC's
// `Xauth username`, and a profile whose username goes unrecognised is reported
// as having none and refused before it is ever dialled.
const L2TP_DETAILS = [
  "connection.uuid:uuid-l2tp",
  "vpn.service-type:org.freedesktop.NetworkManager.l2tp",
  "vpn.data:gateway = 203.0.113.10, ipsec-enabled = yes, ipsec-psk-flags = 0, password-flags = 0, user = alice",
  ""
].join("\n")

test("isL2tpService tells L2TP from the other NetworkManager plugins", () => {
  eq(NetworkManager.isL2tpService("org.freedesktop.NetworkManager.l2tp"), true)
  eq(NetworkManager.isL2tpService("org.freedesktop.NetworkManager.openvpn"), false)
  eq(NetworkManager.isL2tpService("org.freedesktop.NetworkManager.vpnc"), false)
  eq(NetworkManager.isL2tpService(""), false)
})

test("parseNmcliVpnDetails reads the L2TP `user` key as an identity", () => {
  const detail = NetworkManager.parseNmcliVpnDetails(L2TP_DETAILS)["uuid-l2tp"]
  eq(detail.serviceType, "org.freedesktop.NetworkManager.l2tp")
  eq(detail.hasUsername, true)
  eq(detail.gateway, "203.0.113.10")
})

test("an L2TP profile with no user is reported as missing one", () => {
  const raw = [
    "connection.uuid:uuid-bare",
    "vpn.service-type:org.freedesktop.NetworkManager.l2tp",
    "vpn.data:gateway = 203.0.113.10, ipsec-enabled = yes",
    ""
  ].join("\n")
  eq(NetworkManager.parseNmcliVpnDetails(raw)["uuid-bare"].hasUsername, false)
})

test("nmTargets presents L2TP as an ordinary NetworkManager profile", () => {
  const targets = NetworkManager.nmTargets([
    { name: "Datacenter", uuid: "uuid-l2tp", kind: "l2tp", active: false, hasUsername: true, gateway: "203.0.113.10" }
  ])
  eq(targets[0].detail, "L2TP\nGateway: 203.0.113.10")
  eq(targets[0].glyph, Shared.GLYPH_SHIELD_LOCK)
  eq(targets[0].args, ["connection", "up", "uuid", "uuid-l2tp"])
  eq(targets[0].command, undefined)
  eq(NetworkManager.usernameSetting(targets[0]), "user")
})

test("nmTargets names a live L2TP tunnel and its gateway", () => {
  const rows = NetworkManager.nmTargets([
    { name: "Datacenter", uuid: "uuid-l2tp", kind: "l2tp", active: true, gateway: "203.0.113.10" }
  ])
  eq(rows[0].label, "Datacenter")
  eq(rows[0].detail, "L2TP\nGateway: 203.0.113.10")
})

test("nmEmptyText names only the tools that are installed", () => {
  eq(NetworkManager.nmEmptyText({ openvpn: true, wireguard: true }),
    "No profiles yet. Create one with: nmcli connection import type openvpn file <config.ovpn>"
    + " — or: nmcli connection import type wireguard file <config.conf>")

  // The line used to name OpenVPN and WireGuard on a machine that had neither.
  eq(NetworkManager.nmEmptyText({ l2tp: true }).indexOf("openvpn"), -1)
  eq(NetworkManager.nmEmptyText({ l2tp: true }).indexOf("wireguard"), -1)
})

test("nmEmptyText builds rather than imports for the IPsec kinds", () => {
  // L2TP's importer only takes .cnf, which is not what a gateway is handed out
  // as, so the hint has to name every field the profile cannot do without.
  const l2tp = NetworkManager.nmEmptyText({ l2tp: true })
  eq(l2tp.indexOf("vpn-type l2tp") !== -1, true)
  eq(l2tp.indexOf("gateway = <host>") !== -1, true)
  eq(l2tp.indexOf("user = <you>") !== -1, true)
  eq(l2tp.indexOf("ipsec-enabled = yes") !== -1, true)

  // VPNC keeps vpnc.conf's spelling, which is why these are not `gateway` and
  // `username` like everywhere else.
  const vpnc = NetworkManager.nmEmptyText({ vpnc: true })
  eq(vpnc.indexOf("IPSec gateway = <host>") !== -1, true)
  eq(vpnc.indexOf("Xauth username = <you>") !== -1, true)
})

test("nmEmptyText says nothing it cannot back up", () => {
  eq(NetworkManager.nmEmptyText({}), "No profiles yet.")
  eq(NetworkManager.nmEmptyText(), "No profiles yet.")
})

test("nmSummary tells no profiles from none connected", () => {
  eq(NetworkManager.nmSummary([]), "No profiles")
  eq(NetworkManager.nmSummary([{ name: "Work", active: false }]), "Not connected")
  eq(NetworkManager.nmSummary([{ name: "Work", active: true }]), "Work")
})

test("independent profiles all report active and appear in summary", () => {
  const profiles = ["work-prod", "cloud", "work-dev"].map((name, i) =>
    ({ name, uuid: "uuid-" + i, kind: "wireguard", active: true }))
  eq(NetworkManager.nmTargets(profiles).map(row => row.active), [true, true, true])
  eq(NetworkManager.nmSummary(profiles), "cloud + work-dev + work-prod")
  profiles[2].active = false
  eq(NetworkManager.nmSummary(profiles), "cloud + work-prod")
})

test("connecting a profile never generates a teardown of another", () => {
  const profiles = [
    { name: "dev", uuid: "dev", kind: "wireguard", active: true },
    { name: "prod", uuid: "prod", kind: "wireguard", active: false },
    { name: "cloud", uuid: "cloud", kind: "wireguard", active: true }
  ]
  const target = NetworkManager.nmTargets(profiles)[1]
  eq(NetworkManager.nmActivationCommand(target), ["nmcli", "connection", "up", "uuid", "prod"])
  eq(NetworkManager.nmDisconnectArgs(profiles, "dev"), ["connection", "down", "uuid", "dev"])
  eq(NetworkManager.nmDisconnectArgs(profiles, "prod"), [])
  eq(NetworkManager.nmDisconnectArgs(profiles, ""), ["connection", "down", "uuid", "dev", "uuid", "cloud"])
  eq(NetworkManager.nmDisconnectArgs([], ""), [])
  eq(NetworkManager.nmActivationCommand({ command: ["auth-helper", "uuid"] }), ["auth-helper", "uuid"])
})


test("runtime addresses are keyed by profile UUID, including escaped IPv6", () => {
  eq(NetworkManager.parseNmAddresses([
    "GENERAL.UUID:dev", "IP4.ADDRESS[1]:10.8.0.2/32", "IP4.ADDRESS[2]:10.8.0.2/32",
    "IP6.ADDRESS[1]:fd00\\:1234\\:\\:2/128", "",
    "GENERAL.UUID:prod", "IP4.ADDRESS[1]:10.8.0.2/32", "IP6.ADDRESS[1]:--"
  ].join("\n")), { dev: ["10.8.0.2/32", "fd00:1234::2/128"], prod: ["10.8.0.2/32"] })
  eq(NetworkManager.parseNmAddresses(""), {})
})

test("profile entries display type and addresses without hover or duplicate summaries", () => {
  const profiles = [
    { name: "work-dev", uuid: "dev", kind: "wireguard", active: true },
    { name: "work-prod", uuid: "prod", kind: "wireguard", active: true },
    { name: "cloud", uuid: "cloud", kind: "wireguard", active: false }
  ]
  const addresses = { dev: ["10.8.0.2/32"], prod: ["10.8.0.2/32"], cloud: ["old"] }
  const rows = NetworkManager.nmTargets(profiles, "", addresses)
  eq(rows[0].detail, "WireGuard\n10.8.0.2/32")
  eq(rows[1].label, "work-prod")
  eq(rows[1].detail, "WireGuard\n10.8.0.2/32")
  eq(rows[2].label, "cloud")
  eq(rows[2].tooltip, undefined)
  eq(rows[2].detail, "WireGuard")
  eq(NetworkManager.nmConnectionCount(profiles), "2 profiles connected")
  eq(NetworkManager.nmAddressCommand(profiles), ["nmcli", "-t", "-f", "GENERAL.UUID,IP4.ADDRESS,IP6.ADDRESS", "connection", "show", "uuid", "dev", "uuid", "prod"])
  eq(NetworkManager.nmAddressCommand([]), [])
})


test("profile order never follows activation order and has a stable UUID tie-break", () => {
  const cloud = { name: "cloud", uuid: "c", active: false }
  const dev = { name: "work-dev", uuid: "d", active: false }
  const prod = { name: "work-prod", uuid: "p", active: true }
  const expected = ["c", "d", "p"]
  eq(NetworkManager.nmOrderedProfiles([prod, cloud, dev]).map(p => p.uuid), expected)
  dev.active = true
  prod.active = false
  eq(NetworkManager.nmOrderedProfiles([dev, prod, cloud]).map(p => p.uuid), expected)
  eq(NetworkManager.nmOrderedProfiles([{ name: "same", uuid: "b" }, { name: "same", uuid: "a" }]).map(p => p.uuid), ["a", "b"])
})
