// Mullvad: the JSON status payload, the relay list, and the rows built from
// them.
const { test, eq, Shared, Mullvad } = require("../harness.js")

test("parseMullvadStatus reads a connected payload", () => {
  const status = Mullvad.parseMullvadStatus(JSON.stringify({
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
  eq(Mullvad.mullvadSummary(status), "ch-zrh-wg-001 · Zurich, Switzerland")
})

test("parseMullvadStatus treats unparseable output as no idea", () => {
  // Not as disconnected: claiming the tunnel is down when the answer was
  // unreadable is the wrong direction to guess in.
  eq(Mullvad.parseMullvadStatus("not json").state, "")
  eq(Mullvad.parseMullvadStatus("").state, "")
  eq(Mullvad.parseMullvadStatus("[1,2]").state, "")
  eq(Mullvad.mullvadSummary(Mullvad.parseMullvadStatus("")), "Checking…")
})

test("parseMullvadStatus survives details being a bare string", () => {
  const status = Mullvad.parseMullvadStatus('{"state":"disconnecting","details":"reconnect"}')
  eq(status.state, "disconnecting")
  eq(status.connected, false)
})

test("mullvadSummary names the blocked state for what it is", () => {
  const blocked = Mullvad.parseMullvadStatus('{"state":"error"}')
  eq(blocked.blocked, true)
  eq(Mullvad.mullvadSummary(blocked), "Blocked — no traffic is leaving this machine")
  const lockedDown = Mullvad.parseMullvadStatus('{"state":"disconnected","details":{"locked_down":true}}')
  eq(Mullvad.mullvadSummary(lockedDown), "Not connected · traffic blocked")
})

test("mullvadIndentDepth counts a tab and four spaces alike", () => {
  eq(Mullvad.mullvadIndentDepth("Switzerland (ch)"), 0)
  eq(Mullvad.mullvadIndentDepth("\tZurich (zrh)"), 1)
  eq(Mullvad.mullvadIndentDepth("    Zurich (zrh)"), 1)
  eq(Mullvad.mullvadIndentDepth("\t\tch-zrh-wg-001"), 2)
})

test("parseMullvadRelays keeps countries and cities, not relays", () => {
  eq(Mullvad.parseMullvadRelays([
    "Switzerland (ch)",
    "\tZurich (zrh) @ 47.36667°N, 8.55000°W",
    "\t\tch-zrh-wg-001 (185.156.46.146) - hosted by 31173 (rented)",
    "Netherlands (nl)",
    "\tAmsterdam (ams) @ 52.35°N, 4.9°E"
  ].join("\n")), [
    { name: "Switzerland", code: "CH", cities: [{ name: "Zurich", code: "zrh" }] },
    { name: "Netherlands", code: "NL", cities: [{ name: "Amsterdam", code: "ams" }] }
  ])
  eq(Mullvad.parseMullvadRelays(""), [])
})

test("mullvadCountryTargets filters over city names too", () => {
  const countries = Mullvad.parseMullvadRelays([
    "Switzerland (ch)",
    "\tZurich (zrh)",
    "Netherlands (nl)",
    "\tAmsterdam (ams)"
  ].join("\n"))
  eq(Mullvad.mullvadCountryTargets(countries, [], "zurich").map(t => t.label), ["Switzerland"])
  eq(Mullvad.mullvadCountryTargets(countries, ["NL"], "").map(t => t.label),
    ["Netherlands", "Switzerland"])
  eq(Mullvad.mullvadCountryTargets(countries, [], "")[0].detail, "CH · 1 city")
  eq(Mullvad.mullvadCountryTargets(countries, [], "")[0].args, ["ch"])
})

test("mullvadCurrentKey prefers the hostname over the country name", () => {
  const countries = [{ name: "Switzerland", code: "CH", cities: [] }]
  eq(Mullvad.mullvadCurrentKey({ state: "connected", relay: "ch-zrh-wg-504", country: "" }, countries),
    "country:CH")
  // Mid-connect the hostname is not reported yet, so the name has to carry it.
  eq(Mullvad.mullvadCurrentKey({ state: "connecting", relay: "", country: "Switzerland" }, countries),
    "country:CH")
  eq(Mullvad.mullvadCurrentKey({ state: "disconnected", relay: "ch-zrh-wg-504", country: "" }, countries), "")
})

test("parseMullvadSettings marks each answer it actually saw", () => {
  const all = Mullvad.parseMullvadSettings([
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
  const partial = Mullvad.parseMullvadSettings("Autoconnect: on\n")
  eq(partial.loaded, true)
  eq(partial.seen, { autoconnect: true })
  eq(Mullvad.mullvadToggles(partial).map(t => t.key), ["autoconnect"])

  // Each branch answers for itself and for nothing else — the middle
  // subcommand succeeding says nothing about the two around it.
  const middle = Mullvad.parseMullvadSettings("Block traffic when the VPN is disconnected: on\n")
  eq(middle.seen, { lockdown: true })
  eq(Mullvad.mullvadToggles(middle).map(t => t.key), ["lockdown"])
  const last = Mullvad.parseMullvadSettings("Local network sharing setting: allow\n")
  eq(last.seen, { lan: true })
  eq(Mullvad.mullvadToggles(last).map(t => t.key), ["lan"])

  const none = Mullvad.parseMullvadSettings("")
  eq(none.loaded, false)
  eq(none.seen, {})
  eq(Mullvad.mullvadToggles(none), [])
})

test("mullvadToggleArgs speaks each setting's own vocabulary", () => {
  eq(Mullvad.mullvadToggleArgs("autoconnect", true), ["auto-connect", "set", "on"])
  eq(Mullvad.mullvadToggleArgs("lockdown", false), ["lockdown-mode", "set", "off"])
  eq(Mullvad.mullvadToggleArgs("lan", true), ["lan", "set", "allow"])
  eq(Mullvad.mullvadToggleArgs("lan", false), ["lan", "set", "block"])
  eq(Mullvad.mullvadToggleArgs("nonsense", true), [])
})
