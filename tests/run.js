// Tests for Model.js — the pure half of the widget, where every assumption
// about how three CLIs format their output is written down.
//
//   node tests/run.js
//
// No dependencies and no test framework: the plugin ships no package.json and
// is not built, so a test suite that needed installing would not get run.
//
// Model.js is a QML `.pragma library`, which has no module system — just
// top-level declarations. Running it in this realm's global scope turns those
// into globals, which is as close to importing it as node gets without a QML
// engine; collecting the names it added gives back something shaped like a
// module. A fresh VM context would be tidier, but its arrays would carry that
// context's prototypes and every deepStrictEqual would fail on realm alone.

const fs = require("fs")
const path = require("path")
const vm = require("vm")
const assert = require("assert")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
  .replace(/^\s*\.pragma\s+library\s*$/m, "")

const before = new Set(Object.getOwnPropertyNames(globalThis))
vm.runInThisContext(source, { filename: "Model.js" })

const Model = {}
for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (!before.has(name)) Model[name] = globalThis[name]
}

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name: name, error: error })
  }
}

const eq = assert.deepStrictEqual

// ------------------------------------------------------------------ shared

test("elide keeps short text and collapses whitespace", () => {
  eq(Model.elide("  a   b  ", 10), "a b")
  eq(Model.elide("abcdefghij", 10), "abcdefghij")
  eq(Model.elide("abcdefghijk", 10), "abcdefghi…")
  eq(Model.elide(null, 10), "")
})

test("applyPendingToggles marks only the flipped switch busy", () => {
  const toggles = [Model.toggle("a", "A", "", false), Model.toggle("b", "B", "", true)]
  const applied = Model.applyPendingToggles(toggles, { a: true })
  eq(applied[0].value, true)
  eq(applied[0].busy, true)
  eq(applied[1].value, true)
  eq(applied[1].busy, false)
  eq(Model.applyPendingToggles(toggles, null), toggles)
})

test("backend id lists round-trip through the comma-separated setting", () => {
  eq(Model.parseBackendIds(" Proton , mullvad ,, proton "), ["proton", "mullvad"])
  eq(Model.parseBackendIds(null), [])
  eq(Model.joinBackendIds(["proton", "mullvad"]), "proton,mullvad")
  eq(Model.toggleBackendId(["proton"], "mullvad"), ["proton", "mullvad"])
  eq(Model.toggleBackendId(["proton", "mullvad"], "proton"), ["mullvad"])
})

// --------------------------------------------------------------- public IP

test("parsePublicIp accepts address literals", () => {
  eq(Model.parsePublicIp("1.2.3.4"), "1.2.3.4")
  eq(Model.parsePublicIp("  8.8.8.8\n"), "8.8.8.8")
  eq(Model.parsePublicIp("2001:DB8::1"), "2001:db8::1")
})

test("parsePublicIp rejects anything that is not one", () => {
  // A captive portal's login page, an error body, a spoofed answer with a
  // trailer: none of these are an exit address, and rendering one would be the
  // widget confirming a route it never saw.
  eq(Model.parsePublicIp("<html>Sign in</html>"), "")
  eq(Model.parsePublicIp("1.2.3.4 extra"), "")
  eq(Model.parsePublicIp("999.1.1.1"), "")
  eq(Model.parsePublicIp("deadbeef"), "")
  eq(Model.parsePublicIp("1:2:::3"), "")
  eq(Model.parsePublicIp("::1::2"), "")
  eq(Model.parsePublicIp(""), "")
  eq(Model.parsePublicIp(null), "")
  eq(Model.parsePublicIp("1.2.3.4".padEnd(50, "0")), "")
})

// ------------------------------------------------------------- Proton VPN

test("parseProtonStatus reads the labelled block", () => {
  const status = Model.parseProtonStatus([
    "Status: Connected",
    "Server: NL#42",
    "Country: Netherlands",
    "Load: 40%",
    "Protocol: WireGuard"
  ].join("\n"))
  eq(status.connected, true)
  eq(status.server, "NL#42")
  eq(status.country, "Netherlands")
  eq(status.load, "40%")
  eq(status.protocol, "WireGuard")
})

test("parseProtonStatus splits the combined server-and-place field", () => {
  const status = Model.parseProtonStatus("Status: Connected\nServer: CH#1129 in Zurich, Switzerland")
  eq(status.server, "CH#1129")
  eq(status.city, "Zurich")
  eq(status.country, "Switzerland")
  eq(Model.protonSummary(status), "CH#1129 · Zurich, Switzerland")
})

test("parseProtonStatus reads the older bare sentence", () => {
  const status = Model.parseProtonStatus("Connected to NL#42")
  eq(status.connected, true)
  eq(status.server, "NL#42")
})

test("parseProtonStatus treats disconnected and noise as not connected", () => {
  eq(Model.parseProtonStatus("Status: Disconnected").connected, false)
  eq(Model.parseProtonStatus("").connected, false)
  eq(Model.parseProtonStatus("garbage\n\n---").connected, false)
  eq(Model.parseProtonStatus("").statusText, "Disconnected")
  eq(Model.protonSummary(Model.parseProtonStatus("")), "Not connected")
})

test("parseProtonCountries skips the header, the rule, and the notice", () => {
  eq(Model.parseProtonCountries([
    "Server list is outdated, updating...",
    "Country                  Code",
    "-----------------------  ----",
    "Netherlands              NL",
    "United States            US"
  ].join("\n")), [
    { name: "Netherlands", code: "NL" },
    { name: "United States", code: "US" }
  ])
})

test("parseProtonConfig reads the two-column table", () => {
  const config = Model.parseProtonConfig([
    "Setting                  Value",
    "-----------------------  ------------",
    "netshield                malware-only",
    "kill-switch              off"
  ].join("\n"))
  eq(config.loaded, true)
  eq(config.values["netshield"], "malware-only")
  eq(config.values["kill-switch"], "off")
  eq(Model.parseProtonConfig("").loaded, false)
})

test("protonToggles reports mode-carrying settings as on", () => {
  const config = Model.parseProtonConfig("netshield  malware-only\nkill-switch  advanced")
  const toggles = Model.protonToggles(config)
  eq(toggles.map(t => t.key), ["kill-switch", "netshield", "port-forwarding"])
  eq(toggles[0].value, true)
  eq(toggles[0].detail, "Mode: advanced")
  eq(toggles[1].value, true)
  eq(toggles[1].detail, "Blocking: malware-only")
  eq(toggles[2].value, false)
  eq(Model.protonToggles(Model.parseProtonConfig("")), [])
})

test("protonToggleArgs restores the remembered mode instead of a default", () => {
  // Switching NetShield off and on again must not silently upgrade a
  // deliberate "malware-only" to the wider default.
  eq(Model.protonToggleArgs("netshield", true, "malware-only"),
    ["config", "set", "netshield", "malware-only"])
  eq(Model.protonToggleArgs("netshield", true, ""),
    ["config", "set", "netshield", "malware-ads-trackers"])
  eq(Model.protonToggleArgs("kill-switch", true, ""),
    ["config", "set", "kill-switch", "standard"])
  eq(Model.protonToggleArgs("netshield", false, "malware-only"),
    ["config", "set", "netshield", "off"])
  eq(Model.protonToggleArgs("nonsense", true, ""), [])
})

test("protonModes remembers the last non-off value", () => {
  const first = Model.protonModes(Model.parseProtonConfig("netshield  malware-only"), {})
  eq(first["netshield"], "malware-only")
  const after = Model.protonModes(Model.parseProtonConfig("netshield  off"), first)
  eq(after["netshield"], "malware-only")
})

test("protonCountryTargets puts favorites first and filters over name and code", () => {
  const countries = [
    { name: "Netherlands", code: "NL" },
    { name: "Switzerland", code: "CH" }
  ]
  eq(Model.protonCountryTargets(countries, ["CH"], "").map(t => t.label),
    ["Switzerland", "Netherlands"])
  eq(Model.protonCountryTargets(countries, ["CH"], "nl").map(t => t.label), ["Netherlands"])
  eq(Model.protonCountryTargets(countries, [], "zzz"), [])
  eq(Model.protonCountryTargets(countries, [], "")[0].args, ["--country", "NL"])
})

test("favoriteCodes normalises and de-duplicates", () => {
  eq(Model.favoriteCodes(" ch , NL ,ch, "), ["CH", "NL"])
  eq(Model.favoriteCodes(null), [])
})

// ----------------------------------------------------------- NetworkManager

test("splitNmcliLine splits on the first unescaped colon", () => {
  eq(Model.splitNmcliLine("home\\:vpn:uuid-1"), ["home:vpn", "uuid-1"])
  eq(Model.splitNmcliLine("plain"), ["plain", ""])
})

test("parseNmcliConnections keeps only tunnels", () => {
  eq(Model.parseNmcliConnections([
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
  eq(Model.parseNmcliConnections(
    "wg0-mullvad:uuid-9:wireguard:yes:/run/NetworkManager/system-connections/wg0-mullvad.nmconnection"
  ), [])
})

test("parseNmcliConnections keeps rows from an nmcli with no FILENAME field", () => {
  // The older-nmcli fallback: the field is dropped from the query and the
  // connection is kept, since a stray row beats a backend that lists nothing.
  eq(Model.parseNmcliConnections("Work VPN:uuid-1:vpn:yes"), [
    { name: "Work VPN", uuid: "uuid-1", kind: "vpn", active: true }
  ])
})

test("parseNmcliVpnDetails reads one block per connection", () => {
  const details = Model.parseNmcliVpnDetails([
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
  eq(Model.isOpenVpnService(details["uuid-1"].serviceType), true)
  eq(details["uuid-2"].hasUsername, false)
  eq(Model.isOpenVpnService(details["uuid-2"].serviceType), false)
})

test("hasVpnUsername ignores an empty username", () => {
  eq(Model.hasVpnUsername("username = alice"), true)
  eq(Model.hasVpnUsername("username = "), false)
  eq(Model.hasVpnUsername("comp-lzo = adaptive"), false)
  eq(Model.hasVpnUsername(""), false)
})

test("nmTargets flags an OpenVPN profile with no username", () => {
  const targets = Model.nmTargets([
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
  eq(Model.nmSummary([]), "No profiles")
  eq(Model.nmSummary([{ name: "Work", active: false }]), "Not connected")
  eq(Model.nmSummary([{ name: "Work", active: true }]), "Work")
})

// ------------------------------------------------------------------ Mullvad

test("parseMullvadStatus reads a connected payload", () => {
  const status = Model.parseMullvadStatus(JSON.stringify({
    state: "connected",
    details: {
      location: { hostname: "ch-zrh-wg-001", country: "Switzerland", city: "Zurich", ipv4: "1.2.3.4" },
      endpoint: { address: "185.156.46.146:51820", protocol: "udp", tunnel_interface: "wg0-mullvad" },
      feature_indicators: ["QuantumResistance"]
    }
  }))
  eq(status.connected, true)
  eq(status.relay, "ch-zrh-wg-001")
  eq(status.protocol, "UDP")
  eq(status.features, ["Quantum Resistance"])
  eq(Model.mullvadSummary(status), "ch-zrh-wg-001 · Zurich, Switzerland")
})

test("parseMullvadStatus treats unparseable output as no idea", () => {
  // Not as disconnected: claiming the tunnel is down when the answer was
  // unreadable is the wrong direction to guess in.
  eq(Model.parseMullvadStatus("not json").state, "")
  eq(Model.parseMullvadStatus("").state, "")
  eq(Model.parseMullvadStatus("[1,2]").state, "")
  eq(Model.mullvadSummary(Model.parseMullvadStatus("")), "Checking…")
})

test("parseMullvadStatus survives details being a bare string", () => {
  const status = Model.parseMullvadStatus('{"state":"disconnecting","details":"reconnect"}')
  eq(status.state, "disconnecting")
  eq(status.connected, false)
})

test("mullvadSummary names the blocked state for what it is", () => {
  const blocked = Model.parseMullvadStatus('{"state":"error"}')
  eq(blocked.blocked, true)
  eq(Model.mullvadSummary(blocked), "Blocked — no traffic is leaving this machine")
  const lockedDown = Model.parseMullvadStatus('{"state":"disconnected","details":{"locked_down":true}}')
  eq(Model.mullvadSummary(lockedDown), "Not connected · traffic blocked")
})

test("mullvadIndentDepth counts a tab and four spaces alike", () => {
  eq(Model.mullvadIndentDepth("Switzerland (ch)"), 0)
  eq(Model.mullvadIndentDepth("\tZurich (zrh)"), 1)
  eq(Model.mullvadIndentDepth("    Zurich (zrh)"), 1)
  eq(Model.mullvadIndentDepth("\t\tch-zrh-wg-001"), 2)
})

test("parseMullvadRelays keeps countries and cities, not relays", () => {
  eq(Model.parseMullvadRelays([
    "Switzerland (ch)",
    "\tZurich (zrh) @ 47.36667°N, 8.55000°W",
    "\t\tch-zrh-wg-001 (185.156.46.146) - hosted by 31173 (rented)",
    "Netherlands (nl)",
    "\tAmsterdam (ams) @ 52.35°N, 4.9°E"
  ].join("\n")), [
    { name: "Switzerland", code: "CH", cities: [{ name: "Zurich", code: "zrh" }] },
    { name: "Netherlands", code: "NL", cities: [{ name: "Amsterdam", code: "ams" }] }
  ])
  eq(Model.parseMullvadRelays(""), [])
})

test("mullvadCountryTargets filters over city names too", () => {
  const countries = Model.parseMullvadRelays([
    "Switzerland (ch)",
    "\tZurich (zrh)",
    "Netherlands (nl)",
    "\tAmsterdam (ams)"
  ].join("\n"))
  eq(Model.mullvadCountryTargets(countries, [], "zurich").map(t => t.label), ["Switzerland"])
  eq(Model.mullvadCountryTargets(countries, ["NL"], "").map(t => t.label),
    ["Netherlands", "Switzerland"])
  eq(Model.mullvadCountryTargets(countries, [], "")[0].detail, "CH · 1 city")
  eq(Model.mullvadCountryTargets(countries, [], "")[0].args, ["ch"])
})

test("mullvadCurrentKey prefers the hostname over the country name", () => {
  const countries = [{ name: "Switzerland", code: "CH", cities: [] }]
  eq(Model.mullvadCurrentKey({ state: "connected", relay: "ch-zrh-wg-504", country: "" }, countries),
    "country:CH")
  // Mid-connect the hostname is not reported yet, so the name has to carry it.
  eq(Model.mullvadCurrentKey({ state: "connecting", relay: "", country: "Switzerland" }, countries),
    "country:CH")
  eq(Model.mullvadCurrentKey({ state: "disconnected", relay: "ch-zrh-wg-504", country: "" }, countries), "")
})

test("parseMullvadSettings marks each answer it actually saw", () => {
  const all = Model.parseMullvadSettings([
    "Autoconnect: off",
    "Block traffic when the VPN is disconnected: on",
    "Local network sharing setting: allow"
  ].join("\n"))
  eq(all.loaded, true)
  eq(all.autoconnect, false)
  eq(all.lockdown, true)
  eq(all.lan, true)
  eq(all.seen, { autoconnect: true, lockdown: true, lan: true })
})

test("parseMullvadSettings does not report an unanswered setting as off", () => {
  // One shell, one exit code — the last subcommand's — so a failed
  // `lockdown-mode get` leaves no line and no error. Reporting lockdown mode as
  // off while it is on is the one mistake this widget must not make.
  const partial = Model.parseMullvadSettings("Autoconnect: on\n")
  eq(partial.loaded, true)
  eq(partial.seen, { autoconnect: true })
  eq(Model.mullvadToggles(partial).map(t => t.key), ["autoconnect"])

  // Each branch answers for itself and for nothing else — the middle
  // subcommand succeeding says nothing about the two around it.
  const middle = Model.parseMullvadSettings("Block traffic when the VPN is disconnected: on\n")
  eq(middle.seen, { lockdown: true })
  eq(Model.mullvadToggles(middle).map(t => t.key), ["lockdown"])
  const last = Model.parseMullvadSettings("Local network sharing setting: allow\n")
  eq(last.seen, { lan: true })
  eq(Model.mullvadToggles(last).map(t => t.key), ["lan"])

  const none = Model.parseMullvadSettings("")
  eq(none.loaded, false)
  eq(none.seen, {})
  eq(Model.mullvadToggles(none), [])
})

test("mullvadToggleArgs speaks each setting's own vocabulary", () => {
  eq(Model.mullvadToggleArgs("autoconnect", true), ["auto-connect", "set", "on"])
  eq(Model.mullvadToggleArgs("lockdown", false), ["lockdown-mode", "set", "off"])
  eq(Model.mullvadToggleArgs("lan", true), ["lan", "set", "allow"])
  eq(Model.mullvadToggleArgs("lan", false), ["lan", "set", "block"])
  eq(Model.mullvadToggleArgs("nonsense", true), [])
})

// ------------------------------------------------------------------ report

for (const failure of failures) {
  console.error("FAIL  " + failure.name)
  console.error("      " + String(failure.error.message).split("\n").join("\n      "))
}

console.log(`${passed} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
