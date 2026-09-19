// Helpers every backend leans on, and the widget's own settings.
const { test, eq, Shared } = require("../harness.js")

test("sentenceList punctuates by length and drops blanks", () => {
  eq(Shared.sentenceList([]), "")
  eq(Shared.sentenceList(["Mullvad"]), "Mullvad")
  eq(Shared.sentenceList(["Mullvad", "Windscribe"]), "Mullvad or Windscribe")
  eq(Shared.sentenceList(["Mullvad", "Windscribe", "OpenVPN"]),
    "Mullvad, Windscribe, or OpenVPN")
  eq(Shared.sentenceList([" Mullvad ", "", null, "Mullvad"]), "Mullvad")
  eq(Shared.sentenceList(["a", "b"], "and"), "a and b")
})

test("elide keeps short text and collapses whitespace", () => {
  eq(Shared.elide("  a   b  ", 10), "a b")
  eq(Shared.elide("abcdefghij", 10), "abcdefghij")
  eq(Shared.elide("abcdefghijk", 10), "abcdefghi…")
  eq(Shared.elide(null, 10), "")
})

test("pickSetup takes the hint and command from the first visible backend with a hint", () => {
  const entries = [
    { id: "proton", hint: "", command: "" },
    { id: "warp", hint: "Cloudflare WARP: accept its terms", command: "warp-cli registration show" },
    { id: "networkmanager", hint: "No profiles", command: undefined }
  ]
  eq(Shared.pickSetup(entries, []), { hint: "Cloudflare WARP: accept its terms", command: "warp-cli registration show" })
  // Hiding WARP moves to the next hint, and never pairs it with WARP's command.
  eq(Shared.pickSetup(entries, ["warp"]), { hint: "No profiles", command: "" })
  eq(Shared.pickSetup(entries, ["warp", "networkmanager"]), { hint: "", command: "" })
  // A detected backend has nothing to set up, whatever it says.
  eq(Shared.pickSetup([{ id: "warp", detected: true, hint: "start the service", command: "sudo systemctl enable --now warp-svc" }], []),
    { hint: "", command: "" })
  // A command without a hint is not offered.
  eq(Shared.pickSetup([{ id: "x", hint: "", command: "run me" }], []), { hint: "", command: "" })
})

test("applyPendingToggles marks only the flipped switch busy", () => {
  const toggles = [Shared.toggle("a", "A", "", false), Shared.toggle("b", "B", "", true)]
  const applied = Shared.applyPendingToggles(toggles, { a: true })
  eq(applied[0].value, true)
  eq(applied[0].busy, true)
  eq(applied[1].value, true)
  eq(applied[1].busy, false)
  eq(Shared.applyPendingToggles(toggles, null), toggles)
})

test("backend id lists round-trip through the comma-separated setting", () => {
  eq(Shared.parseBackendIds(" Proton , mullvad ,, proton "), ["proton", "mullvad"])
  eq(Shared.parseBackendIds(null), [])
  eq(Shared.joinBackendIds(["proton", "mullvad"]), "proton,mullvad")
  eq(Shared.toggleBackendId(["proton"], "mullvad"), ["proton", "mullvad"])
  eq(Shared.toggleBackendId(["proton", "mullvad"], "proton"), ["mullvad"])
})

test("parsePublicIp accepts address literals", () => {
  eq(Shared.parsePublicIp("1.2.3.4"), "1.2.3.4")
  eq(Shared.parsePublicIp("  8.8.8.8\n"), "8.8.8.8")
  eq(Shared.parsePublicIp("2001:DB8::1"), "2001:db8::1")
})

test("parsePublicIp rejects anything that is not one", () => {
  // A captive portal's login page, an error body, a spoofed answer with a
  // trailer: none of these are an exit address, and rendering one would be the
  // widget confirming a route it never saw.
  eq(Shared.parsePublicIp("<html>Sign in</html>"), "")
  eq(Shared.parsePublicIp("1.2.3.4 extra"), "")
  eq(Shared.parsePublicIp("999.1.1.1"), "")
  eq(Shared.parsePublicIp("deadbeef"), "")
  eq(Shared.parsePublicIp("1:2:::3"), "")
  eq(Shared.parsePublicIp("::1::2"), "")
  eq(Shared.parsePublicIp(""), "")
  eq(Shared.parsePublicIp(null), "")
  eq(Shared.parsePublicIp("1.2.3.4".padEnd(50, "0")), "")
})

test("independent backends survive connects in either direction", () => {
  const nm = { allowConcurrent: true, connected: true }
  const other = { connected: true }
  eq(Shared.conflictsWithBackend(nm, other), false)
  eq(Shared.conflictsWithBackend(other, nm), false)
  eq(Shared.conflictsWithBackend(other, other), false)
  eq(Shared.conflictsWithBackend(other, { connected: true }), true)
  eq(Shared.conflictsWithBackend(other, { connected: false }), false)
})

test("independent rows disconnect only themselves while legacy rows connect", () => {
  const nm = { independentTargets: true, currentKey: "first" }
  eq(Shared.targetAction(nm, { key: "second", active: true }), "disconnect")
  eq(Shared.targetAction(nm, { key: "first", active: false }), "connect")
  eq(Shared.targetAction({}, { key: "second", active: true }), "connect")
  eq(Shared.targetIsActive({ currentKey: "first" }, { key: "first" }), true)
  eq(Shared.targetIsActive(nm, { key: "second", active: true }), true)
})


test("master switch is hidden for multiple independent profiles", () => {
  eq(Shared.showMasterSwitch(null), false)
  eq(Shared.showMasterSwitch({ independentTargets: true, targets: [{}, {}] }), false)
  eq(Shared.showMasterSwitch({ independentTargets: true, targets: [{}] }), true)
  eq(Shared.showMasterSwitch({ independentTargets: false, targets: [{}, {}] }), true)
})
