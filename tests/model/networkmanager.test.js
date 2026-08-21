// OpenVPN and WireGuard profiles: how `nmcli` formats what it prints, and
// which rows survive the filtering.
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
  eq(NetworkManager.hasVpnUsername("username = "), false)
  eq(NetworkManager.hasVpnUsername("comp-lzo = adaptive"), false)
  eq(NetworkManager.hasVpnUsername(""), false)
})

test("nmTargets flags an OpenVPN profile with no username", () => {
  const targets = NetworkManager.nmTargets([
    { name: "Work", uuid: "uuid-1", kind: "vpn", active: false, hasUsername: false },
    { name: "Home", uuid: "uuid-2", kind: "wireguard", active: false },
    { name: "Live", uuid: "uuid-3", kind: "vpn", active: true, hasUsername: true }
  ])
  eq(targets[0].detail, "No username set")
  // WireGuard keeps its keys in the profile, so there is nothing to leave out.
  eq(targets[1].detail, "WireGuard profile")
  eq(targets[2].detail, "Connected")
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

test("nmKindLabel names all three kinds", () => {
  eq(NetworkManager.nmKindLabel({ kind: "wireguard" }), "WireGuard")
  eq(NetworkManager.nmKindLabel({ kind: "openconnect" }), "OpenConnect")
  eq(NetworkManager.nmKindLabel({ kind: "vpn" }), "OpenVPN")
})

// A username is an OpenVPN concern. OpenConnect settles identity with the
// gateway during its own authentication, so demanding one would block a
// profile that is perfectly connectable.
test("nmTargets never asks an OpenConnect profile for a username", () => {
  const targets = NetworkManager.nmTargets([
    { name: "Work", uuid: "uuid-oc", kind: "openconnect", active: false, hasUsername: false }
  ], "/plugins/vpn/bin/omarchy-openconnect-auth")
  eq(targets[0].detail, "OpenConnect profile")
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
  eq(targets[0].detail, "OpenConnect profile")
})

test("nmDetails names the gateway for a live OpenConnect tunnel", () => {
  const rows = NetworkManager.nmDetails([
    { name: "Work", uuid: "uuid-oc", kind: "openconnect", active: true, gateway: "vpn.example.com" }
  ])
  eq(rows[1], Shared.detail("Type", "OpenConnect"))
  eq(rows[2], Shared.detail("Gateway", "vpn.example.com"))
})

// OpenVPN and WireGuard have no gateway field, and an empty row would read as
// a missing value rather than an inapplicable one.
test("nmDetails adds no gateway row for the other kinds", () => {
  const rows = NetworkManager.nmDetails([
    { name: "Home", uuid: "uuid-wg", kind: "wireguard", active: true }
  ])
  eq(rows.length, 3)
  eq(rows[2], Shared.detail("Managed by", "NetworkManager"))
})

test("nmSummary tells no profiles from none connected", () => {
  eq(NetworkManager.nmSummary([]), "No profiles")
  eq(NetworkManager.nmSummary([{ name: "Work", active: false }]), "Not connected")
  eq(NetworkManager.nmSummary([{ name: "Work", active: true }]), "Work")
})
