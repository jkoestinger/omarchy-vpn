// ExpressVPN: the status block, the region list, Network Lock, and the setup
// states. Output samples are expressvpnctl 14.x; where a reading could not be
// captured from a live install it is reconstructed from the documented
// behaviour and marked as such, and the parser is written to survive the
// difference.
const { test, eq, Shared, ExpressVpn } = require("../harness.js")

const STATUS_CONNECTED = [
  "Connected to Germany - Frankfurt - 1",
  "Protocol: Lightway UDP",
  "Location: Germany - Frankfurt - 1"
].join("\n")

const STATUS_DISCONNECTED = "Not connected\n"

const STATUS_LOCATED = [
  "Connected to 162.159.132.117",
  "Protocol: Lightway UDP",
  "Location: USA - New York"
].join("\n")

const REGIONS = [
  "Smart Location",
  "USA - New York",
  "USA - New York - 1",
  "USA - Chicago",
  "Germany - Frankfurt - 1",
  "Germany - Frankfurt - 2",
  "Germany - Nuremberg - 1",
  "Switzerland - Zurich - 1",
  "Serbia"
].join("\n")

test("parseExpressStatus reads the connected block", () => {
  const status = ExpressVpn.parseExpressStatus(STATUS_CONNECTED)
  eq(status.loaded, true)
  eq(status.state, "connected")
  eq(status.connected, true)
  eq(status.location, "Germany - Frankfurt - 1")
  eq(status.protocol, "Lightway UDP")
  eq(ExpressVpn.expressSummary(status), "Germany - Frankfurt - 1")
})

test("parseExpressStatus reads the disconnected block", () => {
  const status = ExpressVpn.parseExpressStatus(STATUS_DISCONNECTED)
  eq(status.loaded, true)
  eq(status.state, "disconnected")
  eq(status.connected, false)
  eq(status.location, "")
  eq(ExpressVpn.expressSummary(status), "Not connected")
  eq(ExpressVpn.expressDetails(status), [])
})

// Older builds print the server address on the Connected line and the region
// on the Location line; the summary prefers the human-readable one.
test("parseExpressStatus takes the location from its own line", () => {
  const status = ExpressVpn.parseExpressStatus(STATUS_LOCATED)
  eq(status.loaded, true)
  eq(status.state, "connected")
  eq(status.connected, true)
  eq(status.location, "USA - New York")
  eq(ExpressVpn.expressSummary(status), "USA - New York")
})

test("parseExpressStatus treats an unreadable block as no answer", () => {
  const status = ExpressVpn.parseExpressStatus("")
  eq(status.loaded, false)
  eq(status.state, "")
  eq(status.connected, false)
  eq(ExpressVpn.expressSummary(status), "Checking…")
})

// The stale-not-empty rule: a block that no longer parses is old news, never
// "disconnected".
test("parseExpressStatus never reports garbage as disconnected", () => {
  const status = ExpressVpn.parseExpressStatus("Something unexpected happened")
  eq(status.loaded, false)
  eq(status.state, "")
  eq(status.connected, false)
})

test("parseExpressStatus reads connecting and disconnecting", () => {
  const connecting = ExpressVpn.parseExpressStatus("Connecting\n")
  eq(connecting.loaded, true)
  eq(connecting.state, "connecting")
  eq(connecting.connected, false)
  eq(ExpressVpn.expressSummary(connecting), "Connecting…")

  const down = ExpressVpn.parseExpressStatus("Disconnecting\n")
  eq(down.state, "disconnecting")
  eq(ExpressVpn.expressSummary(down), "Disconnecting…")
})

test("parseRegions groups by country and strips server indexes", () => {
  const regions = ExpressVpn.parseRegions(REGIONS)
  eq(regions.length, 4)
  eq(regions[0].country, "USA")
  eq(regions[0].cities, ["New York", "Chicago"])
  eq(regions[1].country, "Germany")
  eq(regions[1].cities, ["Frankfurt", "Nuremberg"])
  eq(regions[2].country, "Switzerland")
  eq(regions[2].cities, ["Zurich"])
  eq(regions[3].country, "Serbia")
  eq(regions[3].cities, [])
})

test("parseRegions skips the smart location row", () => {
  const regions = ExpressVpn.parseRegions(REGIONS)
  for (const region of regions) {
    eq(region.country.toLowerCase() === "smart location", false)
  }
})

test("parseRegions survives an empty list", () => {
  eq(ExpressVpn.parseRegions(""), [])
})

// A bare line is a country — "Serbia" is one — so a sentence like
// "No regions available" is indistinguishable from "United States" and is
// believed. Nothing filters it; the CLI does not print one today.
test("parseRegions believes a bare line, whatever it says", () => {
  const regions = ExpressVpn.parseRegions("No regions available")
  eq(regions.length, 1)
  eq(regions[0].country, "No regions available")
})

// ExpressVPN names its regions and never prints a country code, so favorites
// match by name and by leading word. The names are ExpressVPN's own — "USA",
// not "US" — so the default CH,NL,US pins nothing on this chip, exactly as it
// pins only US rows on Windscribe's.
test("isExpressFavorite matches by name and leading word", () => {
  const favorites = Shared.favoriteCodes("USA,Serbia")
  eq(ExpressVpn.isExpressFavorite("USA", favorites), true)
  eq(ExpressVpn.isExpressFavorite("Serbia", favorites), true)
  eq(ExpressVpn.isExpressFavorite("US", favorites), false)
  eq(ExpressVpn.isExpressFavorite("Germany", favorites), false)
  eq(ExpressVpn.isExpressFavorite("USA", []), false)
})

test("expressTargets pins favorites and filters", () => {
  const regions = ExpressVpn.parseRegions(REGIONS)
  const favorites = Shared.favoriteCodes("USA")

  const all = ExpressVpn.expressTargets(regions, favorites, "")
  eq(all[0].label, "USA")
  eq(all[0].key, "region:usa")
  eq(all[0].args, ["USA - New York"])
  eq(all.length, 4)

  const filtered = ExpressVpn.expressTargets(regions, [], "zurich")
  eq(filtered.length, 1)
  eq(filtered[0].label, "Switzerland")

  eq(ExpressVpn.expressTargets(regions, [], "nothing"), [])
})

// The tick has to land on the country row the user clicked, even though the
// status names the full region with its server index.
test("expressCurrentKey matches the status back to a row", () => {
  const regions = ExpressVpn.parseRegions(REGIONS)

  const connected = ExpressVpn.parseExpressStatus(STATUS_CONNECTED)
  eq(ExpressVpn.expressCurrentKey(connected, regions), "region:germany")

  const located = ExpressVpn.parseExpressStatus(STATUS_LOCATED)
  eq(ExpressVpn.expressCurrentKey(located, regions), "region:usa")

  const down = ExpressVpn.parseExpressStatus(STATUS_DISCONNECTED)
  eq(ExpressVpn.expressCurrentKey(down, regions), "")
})

test("expressDetails carries protocol while connected", () => {
  const status = ExpressVpn.parseExpressStatus(STATUS_CONNECTED)
  eq(ExpressVpn.expressDetails(status), [
    { label: "Location", value: "Germany - Frankfurt - 1" },
    { label: "Protocol", value: "Lightway UDP" }
  ])
})

test("expressQuickTargets offers the smart row", () => {
  const status = ExpressVpn.parseExpressStatus(STATUS_DISCONNECTED)
  const targets = ExpressVpn.expressQuickTargets(status)
  eq(targets.length, 1)
  eq(targets[0].key, "smart")
  eq(targets[0].args, [])
})

test("parseNetworkLock reads both spellings", () => {
  const on = ExpressVpn.parseNetworkLock("Network lock: on\n")
  eq(on.known, true)
  eq(on.on, true)

  const off = ExpressVpn.parseNetworkLock("Network Lock: Off\n")
  eq(off.known, true)
  eq(off.on, false)

  const unknown = ExpressVpn.parseNetworkLock("Something else entirely")
  eq(unknown.known, false)
  eq(ExpressVpn.expressToggles(unknown), [])
})

test("expressToggles reflects the tool's own reading", () => {
  const toggles = ExpressVpn.expressToggles(ExpressVpn.parseNetworkLock("Network lock: on\n"))
  eq(toggles.length, 1)
  eq(toggles[0].key, "networklock")
  eq(toggles[0].value, true)
})

test("expressToggleArgs builds the set command", () => {
  eq(ExpressVpn.expressToggleArgs("networklock", true), ["set", "networklock", "true"])
  eq(ExpressVpn.expressToggleArgs("networklock", false), ["set", "networklock", "false"])
  eq(ExpressVpn.expressToggleArgs("something", true), [])
})

// The three setup states: not signed in, background mode off, and — when
// neither refusal is named — a status the parser could not read at all. Each
// names its fix; the last one is the fallback that keeps the panel from
// telling the user to install what they already have.
test("expressSetupState names the blocker", () => {
  eq(ExpressVpn.expressSetupState({ present: false, needsLogin: false, needsBackground: false }), "")
  eq(ExpressVpn.expressSetupState({ present: true, needsLogin: true, needsBackground: false }), "login")
  eq(ExpressVpn.expressSetupState({ present: true, needsLogin: false, needsBackground: true }), "background")
  eq(ExpressVpn.expressSetupState({ present: true, needsLogin: false, needsBackground: false, needsStatusCheck: true }), "status")
  eq(ExpressVpn.expressSetupState({ present: true, needsLogin: false, needsBackground: false, needsStatusCheck: false }), "")
})

test("expressSetupHint and SetupCommand agree on the fix", () => {
  const probe = { present: true, needsLogin: true, needsBackground: false }
  eq(ExpressVpn.expressSetupHint(probe), ExpressVpn.EXPRESS_SETUP.login.hint)
  eq(ExpressVpn.expressSetupCommand(probe), "expressvpnctl login")

  const background = { present: true, needsLogin: false, needsBackground: true }
  eq(ExpressVpn.expressSetupHint(background), ExpressVpn.EXPRESS_SETUP.background.hint)
  eq(ExpressVpn.expressSetupCommand(background), "expressvpnctl background enable")

  const unreadable = { present: true, needsLogin: false, needsBackground: false, needsStatusCheck: true }
  eq(ExpressVpn.expressSetupHint(unreadable), ExpressVpn.EXPRESS_SETUP.status.hint)
  eq(ExpressVpn.expressSetupCommand(unreadable), "expressvpnctl status")

  const fine = { present: true, needsLogin: false, needsBackground: false, needsStatusCheck: false }
  eq(ExpressVpn.expressSetupHint(fine), "")
  eq(ExpressVpn.expressSetupCommand(fine), "")
})

test("expressFailureState recognises the refusals", () => {
  eq(ExpressVpn.expressFailureState("Error: Not logged in"), "login")
  eq(ExpressVpn.expressFailureState("Background mode is not enabled. Run expressvpnctl background enable"), "background")
  eq(ExpressVpn.expressFailureState("Something went wrong"), "")
})

test("describeExpressFailure names the fix or shows the tool's words", () => {
  eq(ExpressVpn.describeExpressFailure("Not logged in", "failed"),
    ExpressVpn.EXPRESS_SETUP.login.failure)
  const long = "a very long failure message that keeps going and going and going and going and going and going and going and going and going and going and going and going and going and going"
  const described = ExpressVpn.describeExpressFailure(long, "failed")
  eq(described.length, 140)
  eq(described.endsWith("…"), true)
  eq(ExpressVpn.describeExpressFailure("", "fallback"), "fallback")
})

test("isExpressSignedOut and isExpressBackgroundOff recognise the refusals", () => {
  eq(ExpressVpn.isExpressSignedOut("Error: not logged in"), true)
  eq(ExpressVpn.isExpressSignedOut("Background mode is not enabled"), false)
  eq(ExpressVpn.isExpressBackgroundOff("Background mode is not enabled"), true)
  eq(ExpressVpn.isExpressBackgroundOff("Not logged in"), false)
})
