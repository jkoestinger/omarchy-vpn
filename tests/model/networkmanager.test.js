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

test("nmSummary tells no profiles from none connected", () => {
  eq(NetworkManager.nmSummary([]), "No profiles")
  eq(NetworkManager.nmSummary([{ name: "Work", active: false }]), "Not connected")
  eq(NetworkManager.nmSummary([{ name: "Work", active: true }]), "Work")
})
