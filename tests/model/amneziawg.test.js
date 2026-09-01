// AmneziaWG: plain *.conf profiles brought up with awg-quick, a CLI fork of
// wg-quick. How `awg show interfaces` and the sysfs health line are parsed,
// and which profiles are blocked from connecting.
const { test, eq, Shared, AmneziaWg } = require("../harness.js")

test("parseAwgInterfaces reads whitespace-separated names", () => {
  eq(AmneziaWg.parseAwgInterfaces("home_awg\n"), ["home_awg"])
  eq(AmneziaWg.parseAwgInterfaces("a b\tc\n"), ["a", "b", "c"])
  eq(AmneziaWg.parseAwgInterfaces(""), [])
  eq(AmneziaWg.parseAwgInterfaces("  \n"), [])
})

test("parseAwgInterfaces drops duplicates", () => {
  eq(AmneziaWg.parseAwgInterfaces("home_awg home_awg"), ["home_awg"])
})

test("parseSysfsStats reads one line per interface", () => {
  const health = AmneziaWg.parseSysfsStats([
    "home_awg\t1024\t2048\t203.0.113.9:51820\t0.0.0.0/0,::/0",
    "office_awg\t0\t0\t\t10.10.0.0/24"
  ].join("\n"))
  eq(Object.keys(health).sort(), ["home_awg", "office_awg"])
  eq(health.home_awg, { endpoints: ["203.0.113.9:51820"], rxBytes: 1024, txBytes: 2048, defaultRoute: true })
  eq(health.office_awg, { endpoints: [], rxBytes: 0, txBytes: 0, defaultRoute: false })
})

test("parseSysfsStats skips blank lines", () => {
  eq(AmneziaWg.parseSysfsStats("\n\n"), {})
})

test("formatBytes steps units at 1024 and formatRate appends /s", () => {
  eq(AmneziaWg.formatBytes(512), "512 B")
  eq(AmneziaWg.formatBytes(2048), "2.0 KiB")
  eq(AmneziaWg.formatBytes(15 * 1024 * 1024), "15 MiB")
  eq(AmneziaWg.formatRate(1024), "1.0 KiB/s")
})

test("interfaceFor takes the config basename, case-insensitively", () => {
  eq(AmneziaWg.interfaceFor("/home/user/.config/omarchy/vpn/awg-profiles/home_awg.conf"), "home_awg")
  eq(AmneziaWg.interfaceFor("office.CONF"), "office")
  eq(AmneziaWg.interfaceFor(""), "")
})

test("hasDangerousHooks matches PreUp/PostUp/PreDown/PostDown, not other keys", () => {
  eq(AmneziaWg.hasDangerousHooks("[Interface]\nPrivateKey = x\nPostUp = iptables -A"), true)
  eq(AmneziaWg.hasDangerousHooks("[Interface]\n  PreDown\t=\trm -rf /tmp/x"), true)
  eq(AmneziaWg.hasDangerousHooks("# PostUp = not a real hook, this is a comment"), false)
  eq(AmneziaWg.hasDangerousHooks("[Interface]\nPrivateKey = x\nAddress = 10.8.1.2/24"), false)
})

test("parseProfileListing pairs each path with its hook flag", () => {
  eq(AmneziaWg.parseProfileListing([
    "/profiles/home.conf\tsafe",
    "/profiles/office.conf\thas_hooks",
    ""
  ].join("\n")), [
    { path: "/profiles/home.conf", hasHooks: false },
    { path: "/profiles/office.conf", hasHooks: true }
  ])
})

test("awgTargets blocks a profile with hooks and marks the connected one", () => {
  const targets = AmneziaWg.awgTargets([
    { name: "home", confFile: "/p/home.conf", hasHooks: false, active: true },
    { name: "office", confFile: "/p/office.conf", hasHooks: true, active: false }
  ])
  eq(targets[0].detail, "Connected")
  eq(targets[0].blocked, false)
  eq(targets[0].glyph, Shared.GLYPH_SHIELD)
  eq(targets[1].detail, "Blocked: contains root hooks")
  eq(targets[1].blocked, true)
  eq(targets[1].glyph, Shared.GLYPH_SHIELD_LOCK)
})

test("awgSummary reports the active profile, or the empty/idle states", () => {
  eq(AmneziaWg.awgSummary([]), "No profiles")
  eq(AmneziaWg.awgSummary([{ name: "home", active: false }]), "Not connected")
  eq(AmneziaWg.awgSummary([{ name: "home", active: true }]), "home")
})

test("awgDetails only reports the active profile's rows, with a trailing managed-by line", () => {
  const rows = AmneziaWg.awgDetails(
    [
      { name: "home", confFile: "/p/home.conf", active: true },
      { name: "office", confFile: "/p/office.conf", active: false }
    ],
    { home: { endpoints: ["203.0.113.9:51820"], rxRate: 1024, txRate: 0, rxBytes: 2048, txBytes: 0, defaultRoute: true } }
  )
  eq(rows[0], { label: "Profile", value: "home" })
  eq(rows[1], { label: "Interface", value: "home" })
  eq(rows[rows.length - 1], { label: "Managed by", value: "awg-quick" })
  eq(rows.some(row => row.label === "Default route" && row.value.indexOf("Yes") === 0), true)
})

test("awgDetails is empty when nothing is active", () => {
  eq(AmneziaWg.awgDetails([{ name: "home", confFile: "/p/home.conf", active: false }], {}), [])
})

test("activeAwgProfile finds the connected profile or null", () => {
  eq(AmneziaWg.activeAwgProfile([{ name: "a", active: false }, { name: "b", active: true }]).name, "b")
  eq(AmneziaWg.activeAwgProfile([{ name: "a", active: false }]), null)
})
