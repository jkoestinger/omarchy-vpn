// Proton VPN: how `protonvpn` formats what it prints, and the rows built
// from it.
const { test, eq, Shared, Proton } = require("../harness.js")

test("parseProtonStatus reads the labelled block", () => {
  const status = Proton.parseProtonStatus([
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
  const status = Proton.parseProtonStatus("Status: Connected\nServer: CH#1129 in Zurich, Switzerland")
  eq(status.server, "CH#1129")
  eq(status.city, "Zurich")
  eq(status.country, "Switzerland")
  eq(Proton.protonSummary(status), "CH#1129 · Zurich, Switzerland")
})

test("parseProtonStatus reads the older bare sentence", () => {
  const status = Proton.parseProtonStatus("Connected to NL#42")
  eq(status.connected, true)
  eq(status.server, "NL#42")
})

test("parseProtonStatus treats disconnected and noise as not connected", () => {
  eq(Proton.parseProtonStatus("Status: Disconnected").connected, false)
  eq(Proton.parseProtonStatus("").connected, false)
  eq(Proton.parseProtonStatus("garbage\n\n---").connected, false)
  eq(Proton.parseProtonStatus("").statusText, "Disconnected")
  eq(Proton.protonSummary(Proton.parseProtonStatus("")), "Not connected")
})

test("parseProtonCountries skips the header, the rule, and the notice", () => {
  eq(Proton.parseProtonCountries([
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
  const config = Proton.parseProtonConfig([
    "Setting                  Value",
    "-----------------------  ------------",
    "netshield                malware-only",
    "kill-switch              off"
  ].join("\n"))
  eq(config.loaded, true)
  eq(config.values["netshield"], "malware-only")
  eq(config.values["kill-switch"], "off")
  eq(Proton.parseProtonConfig("").loaded, false)
})

test("protonToggles reports mode-carrying settings as on", () => {
  const config = Proton.parseProtonConfig("netshield  malware-only\nkill-switch  advanced")
  const toggles = Proton.protonToggles(config)
  eq(toggles.map(t => t.key), ["kill-switch", "netshield", "port-forwarding"])
  eq(toggles[0].value, true)
  eq(toggles[0].detail, "Mode: advanced")
  eq(toggles[1].value, true)
  eq(toggles[1].detail, "Blocking: malware-only")
  eq(toggles[2].value, false)
  eq(Proton.protonToggles(Proton.parseProtonConfig("")), [])
})

test("protonToggleArgs restores the remembered mode instead of a default", () => {
  // Switching NetShield off and on again must not silently upgrade a
  // deliberate "malware-only" to the wider default.
  eq(Proton.protonToggleArgs("netshield", true, "malware-only"),
    ["config", "set", "netshield", "malware-only"])
  eq(Proton.protonToggleArgs("netshield", true, ""),
    ["config", "set", "netshield", "malware-ads-trackers"])
  eq(Proton.protonToggleArgs("kill-switch", true, ""),
    ["config", "set", "kill-switch", "standard"])
  eq(Proton.protonToggleArgs("netshield", false, "malware-only"),
    ["config", "set", "netshield", "off"])
  eq(Proton.protonToggleArgs("nonsense", true, ""), [])
})

test("protonModes remembers the last non-off value", () => {
  const first = Proton.protonModes(Proton.parseProtonConfig("netshield  malware-only"), {})
  eq(first["netshield"], "malware-only")
  const after = Proton.protonModes(Proton.parseProtonConfig("netshield  off"), first)
  eq(after["netshield"], "malware-only")
})

test("protonCountryTargets puts favorites first and filters over name and code", () => {
  const countries = [
    { name: "Netherlands", code: "NL" },
    { name: "Switzerland", code: "CH" }
  ]
  eq(Proton.protonCountryTargets(countries, ["CH"], "").map(t => t.label),
    ["Switzerland", "Netherlands"])
  eq(Proton.protonCountryTargets(countries, ["CH"], "nl").map(t => t.label), ["Netherlands"])
  eq(Proton.protonCountryTargets(countries, [], "zzz"), [])
  eq(Proton.protonCountryTargets(countries, [], "")[0].args, ["--country", "NL"])
})

test("favoriteCodes normalises and de-duplicates", () => {
  eq(Shared.favoriteCodes(" ch , NL ,ch, "), ["CH", "NL"])
  eq(Shared.favoriteCodes(null), [])
})

// Signed out, every subcommand that needs an account is refused this way and
// exits 2, while `protonvpn status` exits 0 the whole time — so this is the
// only thing that tells the backend to stop asking.
test("protonAuthRequired reads the CLI's refusals", () => {
  eq(Proton.protonAuthRequired(
    "Error: Authentication required to view feature status. Please sign in with 'protonvpn signin'"), true)
  eq(Proton.protonAuthRequired("Error: Authentication required to list countries."), true)
  eq(Proton.protonAuthRequired("You are not logged in"), true)
  eq(Proton.protonAuthRequired(""), false)
  eq(Proton.protonAuthRequired(null), false)
  // A refusal is not the same as a tool that is unwell, and only the first of
  // these should stop the poll asking again.
  eq(Proton.protonAuthRequired("Error: could not reach the Proton VPN API"), false)
  eq(Proton.protonAuthRequired("Status: Disconnected"), false)
})

// Two overlapping `protonvpn` processes destroy the stored session (see
// protonCli), so the shape of the argv matters as much as the arguments in it.
test("protonCli queues every invocation behind one lock", () => {
  const command = Proton.protonCli(["connect", "NL"])
  eq(command[0], "sh")
  eq(command[1], "-c")
  eq(command[2], 'exec flock -w 60 "${XDG_RUNTIME_DIR:-$HOME/.cache}/omarchy-vpn-protonvpn.lock" protonvpn "$@"')
  // $0 names the shell; the CLI's own arguments start at $1.
  eq(command.slice(3), ["protonvpn", "connect", "NL"])
})

test("protonCli takes no arguments as a bare subcommandless call", () => {
  eq(Proton.protonCli([]).length, 4)
  eq(Proton.protonCli().length, 4)
})

test("protonNextRead asks for one thing at a time, status first", () => {
  const owed = { statusDue: true, configLoaded: false, countriesLoaded: false }
  eq(Proton.protonNextRead(owed), "status")
  eq(Proton.protonNextRead(Object.assign({}, owed, { statusDue: false })), "config")
  eq(Proton.protonNextRead({ configLoaded: true }), "countries")
  eq(Proton.protonNextRead({ configLoaded: true, countriesLoaded: true }), "")
})

test("protonNextRead starts nothing while this instance has a call out", () => {
  eq(Proton.protonNextRead({ busy: true, statusDue: true }), "")
})

// A signed-out CLI refuses both of these for as long as nobody signs in, and
// each refusal costs a Python start.
test("protonNextRead stops asking for what needs an account when signed out", () => {
  eq(Proton.protonNextRead({ signedOut: true }), "")
  eq(Proton.protonNextRead({ signedOut: true, statusDue: true }), "status")
})
