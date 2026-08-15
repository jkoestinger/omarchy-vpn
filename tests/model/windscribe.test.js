// Windscribe: the status block, the location list, and the call queue reducer
// that keeps two widget instances from losing the CLI's machine-wide lock.
const { test, eq, Shared, Windscribe } = require("../harness.js")

const WINDSCRIBE_CONNECTED = [
  "Internet connectivity: available",
  "Login state: Logged in",
  "Firewall state: On",
  "Connect state: Connected: Zurich - Alphorn",
  "Protocol: WireGuard:443",
  "Data usage: 96.99 MB / 2.00 GB",
  "Update available: 2.23.11"
].join("\n")

const WINDSCRIBE_DISCONNECTED = [
  "Internet connectivity: available",
  "Login state: Logged in",
  "Firewall state: Off",
  "Connect state: Disconnected",
  "Data usage: 0 bytes / 2.00 GB"
].join("\n")

const WINDSCRIBE_LOCATIONS = [
  "Best Location - Alphorn (10 Gbps)",
  "US East - New York - Empire (10 Gbps)",
  "US East - Boston - MIT (Pro) (10 Gbps)",
  "US West - Seattle - Cobain (10 Gbps)",
  "Switzerland - Zurich - Alphorn (10 Gbps)",
  "Switzerland - Zurich - Altstadt (Pro) (10 Gbps)",
  "Japan - Tokyo - Shinkansen (Pro) (10 Gbps)",
  "Nowhere - Ghost Town - Closed (Pro) (Disabled)"
].join("\n")

test("parseWindscribeStatus reads the connected block", () => {
  const status = Windscribe.parseWindscribeStatus(WINDSCRIBE_CONNECTED)
  eq(status.loaded, true)
  eq(status.loggedIn, true)
  eq(status.state, "connected")
  eq(status.connected, true)
  eq(status.city, "Zurich")
  eq(status.nickname, "Alphorn")
  eq(status.protocol, "WireGuard")
  eq(status.port, "443")
  eq(status.dataUsed, "96.99 MB")
  eq(status.dataLimit, "2.00 GB")
  eq(status.firewallKnown, true)
  eq(status.firewallOn, true)
  eq(status.firewallAlways, false)
  eq(status.statusText, "Connected")
})

test("parseWindscribeStatus reads the disconnected block", () => {
  const status = Windscribe.parseWindscribeStatus(WINDSCRIBE_DISCONNECTED)
  eq(status.state, "disconnected")
  eq(status.connected, false)
  eq(status.firewallKnown, true)
  eq(status.firewallOn, false)
  eq(status.protocol, "")
  eq(Windscribe.windscribeSummary(status), "Not connected")
})

test("parseWindscribeStatus treats an unreadable block as no answer", () => {
  const status = Windscribe.parseWindscribeStatus("")
  eq(status.loaded, false)
  eq(status.state, "")
  eq(status.connected, false)
  eq(status.firewallKnown, false)
  eq(Windscribe.windscribeSummary(status), "Checking…")
  eq(Windscribe.windscribeToggles(status), [])
})

// The one failure mode `connect -n` cannot report through its exit code.
test("parseWindscribeStatus keeps a failed connect out of the connected state", () => {
  const status = Windscribe.parseWindscribeStatus(
    "Login state: Logged in\nFirewall state: Off\nConnect state: Error: Location does not exist or is disabled")
  eq(status.state, "error")
  eq(status.connected, false)
  eq(status.error, "Location does not exist or is disabled")
  eq(Windscribe.windscribeSummary(status), "Not connected")
  eq(Windscribe.windscribeDetails(status), [])
})

test("parseWindscribeStatus keeps the reason on a disconnect that has one", () => {
  const limit = "Disconnected due to reaching WireGuard key limit.  Use \"windscribe-cli keylimit delete\" if you want to."
  const status = Windscribe.parseWindscribeStatus("Login state: Logged in\nConnect state: " + limit)
  eq(status.state, "disconnected")
  eq(status.connected, false)
  eq(status.error, limit)
})

test("parseWindscribeStatus reads connecting, disconnecting and interference", () => {
  const connecting = Windscribe.parseWindscribeStatus("Login state: Logged in\nConnect state: Connecting: Zurich - Alphorn")
  eq(connecting.state, "connecting")
  eq(connecting.connected, false)
  eq(Windscribe.windscribeSummary(connecting), "Connecting to Alphorn · Zurich…")

  const bare = Windscribe.parseWindscribeStatus("Login state: Logged in\nConnect state: Connecting")
  eq(bare.state, "connecting")
  eq(Windscribe.windscribeSummary(bare), "Connecting…")

  const down = Windscribe.parseWindscribeStatus("Login state: Logged in\nConnect state: Disconnecting")
  eq(down.state, "disconnecting")
  eq(Windscribe.windscribeSummary(down), "Disconnecting…")

  const noisy = Windscribe.parseWindscribeStatus(
    "Login state: Logged in\nConnect state: Connected: Zurich - Alphorn [Network interference]")
  eq(noisy.state, "connected")
  eq(noisy.nickname, "Alphorn")
  eq(noisy.interference, true)
  eq(Windscribe.windscribeSummary(noisy), "Alphorn · Zurich · network interference")
})

test("windscribeSummary says so when a logged-out client is all there is", () => {
  const status = Windscribe.parseWindscribeStatus("Login state: Logged out\nFirewall state: Off\nConnect state: Disconnected")
  eq(status.loggedIn, false)
  eq(status.statusText, "Not logged in")
  eq(Windscribe.windscribeSummary(status), "Not logged in")
})

// The firewall is a kill switch, so an unrecognized spelling is unknown rather
// than off — a switch that is not drawn beats one that is confidently wrong.
test("parseWindscribeStatus believes only the firewall spellings it knows", () => {
  const always = Windscribe.parseWindscribeStatus("Login state: Logged in\nFirewall state: Always On")
  eq(always.firewallOn, true)
  eq(always.firewallAlways, true)
  eq(Windscribe.windscribeToggles(always)[0].detail, "Always on — change it in the Windscribe app")

  const odd = Windscribe.parseWindscribeStatus("Login state: Logged in\nFirewall state: Whatever")
  eq(odd.firewallKnown, false)
  eq(odd.firewallOn, false)
  eq(Windscribe.windscribeToggles(odd), [])
})

test("windscribeDetails reports the server, the plan and the protocol", () => {
  eq(Windscribe.windscribeDetails(Windscribe.parseWindscribeStatus(WINDSCRIBE_CONNECTED)), [
    { label: "Server", value: "Alphorn" },
    { label: "Location", value: "Zurich" },
    { label: "Protocol", value: "WireGuard · 443" },
    { label: "Data used", value: "96.99 MB of 2.00 GB" }
  ])
  eq(Windscribe.windscribeDetails(Windscribe.parseWindscribeStatus(WINDSCRIBE_DISCONNECTED)), [])
})

test("parseWindscribeLocations strips the markers and keeps the names", () => {
  const locations = Windscribe.parseWindscribeLocations(WINDSCRIBE_LOCATIONS)
  eq(locations.length, 8)
  eq(locations[0], { region: "Best Location", city: "", nickname: "Alphorn", pro: false, disabled: false })
  eq(locations[2], { region: "US East", city: "Boston", nickname: "MIT", pro: true, disabled: false })
  eq(locations[7], { region: "Nowhere", city: "Ghost Town", nickname: "Closed", pro: true, disabled: true })
})

test("parseWindscribeLocations ignores the empty and static-IP preamble lines", () => {
  eq(Windscribe.parseWindscribeLocations("(Device name: laptop)\n\nNo locations.\n"), [])
  eq(Windscribe.parseWindscribeLocations(null), [])
})

test("windscribeRegions groups the list and drops what cannot be connected to", () => {
  const regions = Windscribe.windscribeRegions(Windscribe.parseWindscribeLocations(WINDSCRIBE_LOCATIONS))
  eq(regions.map(region => region.name), ["US East", "US West", "Switzerland", "Japan"])
  eq(regions[0].cities, ["New York", "Boston"])
  eq(regions[0].total, 2)
  eq(regions[0].free, 1)
  eq(regions[3].free, 0)
  eq(Windscribe.windscribeBestNickname(Windscribe.parseWindscribeLocations(WINDSCRIBE_LOCATIONS)), "Alphorn")
})

test("windscribeRegionTargets connect by region name and warn about Pro", () => {
  const regions = Windscribe.windscribeRegions(Windscribe.parseWindscribeLocations(WINDSCRIBE_LOCATIONS))
  const targets = Windscribe.windscribeRegionTargets(regions, [], "")

  eq(targets[0], {
    key: "region:us east",
    label: "US East",
    detail: "2 cities",
    glyph: Shared.GLYPH_VPN,
    args: ["US East"]
  })
  eq(targets[3].detail, "1 city · Pro only")
})

test("windscribeRegionTargets filter over region, city and nickname", () => {
  const regions = Windscribe.windscribeRegions(Windscribe.parseWindscribeLocations(WINDSCRIBE_LOCATIONS))
  const names = filter => Windscribe.windscribeRegionTargets(regions, [], filter).map(target => target.label)

  eq(names("zurich"), ["Switzerland"])
  eq(names("cobain"), ["US West"])
  eq(names("us "), ["US East", "US West"])
  eq(names("nowhere"), [])
})

// Windscribe prints no country codes, so the shared favorites setting has to
// match on the name — and on its leading word, or "US" would match nothing.
test("windscribe favorites match region names and leading words", () => {
  const regions = Windscribe.windscribeRegions(Windscribe.parseWindscribeLocations(WINDSCRIBE_LOCATIONS))
  const order = favorites => Windscribe.windscribeRegionTargets(regions, favorites, "").map(target => target.label)

  eq(order(Shared.favoriteCodes("Switzerland")), ["Switzerland", "US East", "US West", "Japan"])
  eq(order(Shared.favoriteCodes("us")), ["US East", "US West", "Switzerland", "Japan"])
  eq(order(Shared.favoriteCodes("CH,NL")), ["US East", "US West", "Switzerland", "Japan"])
  eq(Windscribe.isWindscribeFavorite("US East", []), false)
})

test("windscribeQuickTargets name the server best resolves to when it is known", () => {
  eq(Windscribe.windscribeQuickTargets("Alphorn")[0].detail, "Currently Alphorn")
  eq(Windscribe.windscribeQuickTargets("")[0].detail, "Let Windscribe pick")
  eq(Windscribe.windscribeQuickTargets("")[0].args, ["best"])
})

// Status names a city and a nickname; the list is what says which region they
// are in, so the tick has to be looked back up rather than read off.
test("windscribeCurrentKey finds the region behind the connected server", () => {
  const regions = Windscribe.windscribeRegions(Windscribe.parseWindscribeLocations(WINDSCRIBE_LOCATIONS))

  eq(Windscribe.windscribeCurrentKey(Windscribe.parseWindscribeStatus(WINDSCRIBE_CONNECTED), regions), "region:switzerland")
  eq(Windscribe.windscribeCurrentKey(Windscribe.parseWindscribeStatus(WINDSCRIBE_DISCONNECTED), regions), "")

  const connecting = Windscribe.parseWindscribeStatus("Login state: Logged in\nConnect state: Connecting: Boston - MIT")
  eq(Windscribe.windscribeCurrentKey(connecting, regions), "region:us east")

  const nicknameOnly = Windscribe.parseWindscribeStatus("Login state: Logged in\nConnect state: Connected: Cobain")
  eq(Windscribe.windscribeCurrentKey(nicknameOnly, regions), "region:us west")

  const unknown = Windscribe.parseWindscribeStatus("Login state: Logged in\nConnect state: Connected: Atlantis - Trident")
  eq(Windscribe.windscribeCurrentKey(unknown, regions), "")
})

// Two overlapping invocations lose both answers, so the backend serialises its
// calls — but the user at a terminal is outside that queue, and what comes back
// then is a refusal rather than a reading.
test("isWindscribeCliLocked spots the refusal a second invocation gets", () => {
  eq(Windscribe.isWindscribeCliLocked("cli: \"Windscribe CLI is already running\""), true)
  eq(Windscribe.isWindscribeCliLocked("Windscribe CLI is already running"), true)
  eq(Windscribe.isWindscribeCliLocked(WINDSCRIBE_DISCONNECTED), false)
  eq(Windscribe.isWindscribeCliLocked(""), false)
  eq(Windscribe.isWindscribeCliLocked(null), false)
})

test("windscribeToggleArgs speak the CLI's firewall vocabulary", () => {
  eq(Windscribe.windscribeToggleArgs("firewall", true), ["firewall", "on"])
  eq(Windscribe.windscribeToggleArgs("firewall", false), ["firewall", "off"])
  eq(Windscribe.windscribeToggleArgs("nonsense", true), [])
})

// A kill switch nobody can read is not a kill switch that is off. The panel's
// summary reports what the tool said; this weighs what it might be doing, and
// it is what decides whether switching tools comes with a warning.
test("windscribeBlocksWhileDown counts an unreadable firewall as maybe blocking", () => {
  const on = Windscribe.parseWindscribeStatus("Login state: Logged in\nFirewall state: On\nConnect state: Disconnected")
  const off = Windscribe.parseWindscribeStatus("Login state: Logged in\nFirewall state: Off\nConnect state: Disconnected")
  const odd = Windscribe.parseWindscribeStatus("Login state: Logged in\nFirewall state: Whatever\nConnect state: Disconnected")

  eq(Windscribe.windscribeBlocksWhileDown(on), true)
  eq(Windscribe.windscribeBlocksWhileDown(off), false)
  eq(Windscribe.windscribeBlocksWhileDown(odd), true)
  // Never asked is not the same as asked and unreadable: with no reading at all
  // the backend is not detected, and warning about it would be noise.
  eq(Windscribe.windscribeBlocksWhileDown(Windscribe.parseWindscribeStatus("")), false)
  eq(Windscribe.windscribeBlocksWhileDown(null), false)
})

const kinds = queue => queue.map(job => job.kind)

test("windscribeEnqueue puts reads at the back and actions at the front", () => {
  let queue = []
  queue = Windscribe.windscribeEnqueue(queue, "", "status", ["status"])
  queue = Windscribe.windscribeEnqueue(queue, "", "locations", ["locations"])
  eq(kinds(queue), ["status", "locations"])

  queue = Windscribe.windscribeEnqueue(queue, "", "connect", ["connect", "-n", "best"])
  eq(kinds(queue), ["connect", "status", "locations"])
  eq(queue[0].args, ["connect", "-n", "best"])
  eq(queue[0].attempts, 0)
})

// The poll fires faster than the CLI answers, so without this the queue grows a
// backlog of stale reads and the panel runs a cycle behind forever.
test("windscribeEnqueue drops a read that is already queued or running", () => {
  const queued = Windscribe.windscribeEnqueue([], "", "status", ["status"])

  eq(Windscribe.windscribeEnqueue(queued, "", "status", ["status"]), queued)
  eq(Windscribe.windscribeEnqueue([], "status", "status", ["status"]), [])
  eq(Windscribe.windscribeEnqueue([], "locations", "status", ["status"]).length, 1)

  // Actions are not reads: two clicks are two intentions, and the caller — not
  // the queue — is what decides a second one is redundant.
  const twice = Windscribe.windscribeEnqueue(
    Windscribe.windscribeEnqueue([], "", "connect", ["a"]), "", "connect", ["b"])
  eq(kinds(twice), ["connect", "connect"])
})

test("windscribeRequeue returns the job to the front, one attempt older", () => {
  const job = { kind: "status", args: ["status"], attempts: 0 }
  const queue = Windscribe.windscribeRequeue([{ kind: "locations", args: [], attempts: 0 }], job)

  eq(kinds(queue), ["status", "locations"])
  eq(queue[0].attempts, 1)
  // A fresh object: nothing holding the old job sees its count move.
  eq(job.attempts, 0)
})

test("windscribeCanRetry stops knocking after four attempts", () => {
  eq(Windscribe.windscribeCanRetry({ kind: "status", args: [], attempts: 0 }), true)
  eq(Windscribe.windscribeCanRetry({ kind: "status", args: [], attempts: 3 }), true)
  eq(Windscribe.windscribeCanRetry({ kind: "status", args: [], attempts: 4 }), false)
  eq(Windscribe.windscribeCanRetry(null), false)
})

// Two widget instances lose the lock together and would back off together, so
// the draw is what separates them — the attempt count is identical on both.
test("windscribeRetryDelay grows with attempts and spreads with the draw", () => {
  eq(Windscribe.windscribeRetryDelay(1, 0), 120)
  eq(Windscribe.windscribeRetryDelay(2, 0), 240)
  eq(Windscribe.windscribeRetryDelay(1, 1), 400)
  eq(Windscribe.windscribeRetryDelay(1, 0.5), 260)
  // A draw outside 0..1, or no draw at all, must not produce a negative or
  // absurd interval — a Timer given one never fires again.
  eq(Windscribe.windscribeRetryDelay(1, -5), 120)
  eq(Windscribe.windscribeRetryDelay(1, 99), 400)
  eq(Windscribe.windscribeRetryDelay(1, undefined), 120)
})

test("windscribePending sees both the running job and the waiting ones", () => {
  const queue = [{ kind: "toggle", args: [], attempts: 0 }]

  eq(Windscribe.windscribePending(queue, "status", ["toggle"]), true)
  eq(Windscribe.windscribePending(queue, "connect", ["connect", "disconnect"]), true)
  eq(Windscribe.windscribePending(queue, "status", ["connect", "disconnect"]), false)
  eq(Windscribe.windscribePending([], "", ["connect"]), false)
})

// The name is handed to `windscribe-cli connect` as an argument, where a
// leading dash reads as an option rather than as a place.
test("windscribeRegions drops a region name that would parse as a flag", () => {
  const locations = Windscribe.parseWindscribeLocations(
    "--nope - Somewhere - Trap (10 Gbps)\nSwitzerland - Zurich - Alphorn (10 Gbps)")

  eq(Windscribe.windscribeRegions(locations).map(region => region.name), ["Switzerland"])
})
