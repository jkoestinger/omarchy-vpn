.pragma library
.import "Shared.js" as Shared

// AmneziaWG: the obfuscated WireGuard fork AmneziaVPN ships (protocol name
// "AmneziaWG", tools `awg` / `awg-quick`), driven the same way WireGuard would
// be if this widget had a plain-WireGuard backend — plain `*.conf` profiles in
// a directory, brought up and down with `awg-quick`. Parsing and row-building
// only; the process plumbing lives in AmneziaWgBackend.qml.
//
// `awg` and `awg-quick` are a drop-in CLI fork of `wg` and `wg-quick`: same
// subcommands, same `show interfaces` output, same "interface name is the
// config basename" convention. What AmneziaWG adds lives entirely inside the
// `.conf` file — `Jc`/`Jmin`/`Jmax`/`S1`/`S2`/`H1`-`H4` in `[Interface]`, which
// `awg-quick` understands and plain `wg-quick` would silently ignore (or, on
// stricter builds, reject). None of that reaches this file: from here a
// profile is just a path and a hooks flag.

// `awg show interfaces` separates interface names with whitespace. An empty
// read, or a read that failed, means nothing is up.
function parseAwgInterfaces(raw) {
  var names = []
  var parts = String(raw || "").trim().split(/\s+/)
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim()
    if (name === "") continue
    if (names.indexOf(name) < 0) names.push(name)
  }
  return names
}

// One line per up interface: "<iface>\t<rxBytes>\t<txBytes>\t<endpoint>\t<allowedIPs>",
// built by the backend from /sys/class/net counters plus the matching profile's
// Endpoint/AllowedIPs (see AmneziaWgBackend.qml's healthProcess). `wg`/`awg`
// keep per-peer stats behind root, so the sysfs counters are what a normal user
// can read without elevating just to watch throughput.
function parseSysfsStats(raw) {
  var health = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    var fields = line.split("\t")
    var iface = String(fields[0] || "").trim()
    if (iface === "") continue
    var rx = parseInt(fields[1], 10) || 0
    var tx = parseInt(fields[2], 10) || 0
    var endpoint = String(fields[3] || "").trim()
    var allowed = String(fields[4] || "").split(",")
    var defaultRoute = false
    for (var j = 0; j < allowed.length; j++) {
      var cidr = allowed[j].trim()
      if (cidr === "0.0.0.0/0" || cidr === "::/0") defaultRoute = true
    }
    health[iface] = {
      endpoints: endpoint !== "" ? [endpoint] : [],
      rxBytes: rx,
      txBytes: tx,
      defaultRoute: defaultRoute
    }
  }
  return health
}

function formatBytes(bytes) {
  var value = Math.max(0, Number(bytes) || 0)
  var units = ["B", "KiB", "MiB", "GiB", "TiB"]
  var index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return (index === 0 ? String(Math.floor(value)) : value.toFixed(value >= 10 ? 0 : 1)) + " " + units[index]
}

function formatRate(bytesPerSecond) {
  return formatBytes(bytesPerSecond) + "/s"
}

// The config basename is the interface name awg-quick would bring up — same
// rule wg-quick uses, since awg-quick is a fork of it.
function interfaceFor(confFile) {
  var base = String(confFile || "").replace(/\\/g, "/").split("/").pop()
  return base.replace(/\.conf$/i, "")
}

// A PreUp/PostUp/PreDown/PostDown line runs as root the moment awg-quick brings
// the interface up or down — the same hazard a plain WireGuard profile carries,
// and one a dropped-in `.conf` file is exactly the way to hide. Profiles
// carrying one are listed but refused at connect time rather than silently
// stripped, so the user sees why rather than wondering why nothing happened.
function hasDangerousHooks(confText) {
  var lines = String(confText || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line.indexOf("#") === 0 || line.indexOf(";") === 0) continue
    if (/^(preup|postup|predown|postdown)\s*=/i.test(line)) return true
  }
  return false
}

// One "<path>\t<safe|has_hooks>" line per profile, produced by the backend's
// listProcess.
function parseProfileListing(raw) {
  var list = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    var parts = line.split("\t")
    var path = parts[0].trim()
    var hasHooks = parts.length > 1 ? parts[1].trim() === "has_hooks" : false
    if (path !== "") list.push({ path: path, hasHooks: hasHooks })
  }
  return list
}

function awgTargets(profiles) {
  var targets = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    var detailText = profile.hasHooks
      ? "Blocked: contains root hooks"
      : (profile.active ? "Connected" : "AmneziaWG profile")
    targets.push({
      key: "profile:" + profile.name,
      label: profile.name,
      detail: detailText,
      glyph: profile.hasHooks ? Shared.GLYPH_SHIELD_LOCK : Shared.GLYPH_SHIELD,
      confFile: profile.confFile,
      active: profile.active,
      hasHooks: profile.hasHooks === true,
      blocked: profile.hasHooks === true
    })
  }
  return targets
}

function awgSummary(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i].name
  }
  return profiles.length === 0 ? "No profiles" : "Not connected"
}

function awgDetails(profiles, healthByInterface) {
  var rows = []
  for (var i = 0; i < profiles.length; i++) {
    if (!profiles[i].active) continue
    var iface = interfaceFor(profiles[i].confFile)
    var health = healthByInterface ? healthByInterface[iface] : null
    rows.push(Shared.detail("Profile", profiles[i].name))
    rows.push(Shared.detail("Interface", iface))
    if (health) {
      if (health.endpoints.length > 0) rows.push(Shared.detail("Endpoint", health.endpoints.join(", ")))
      rows.push(Shared.detail("Receiving", formatRate(health.rxRate || 0)))
      rows.push(Shared.detail("Sending", formatRate(health.txRate || 0)))
      rows.push(Shared.detail("Downloaded", formatBytes(health.rxBytes)))
      rows.push(Shared.detail("Uploaded", formatBytes(health.txBytes)))
      rows.push(Shared.detail("Default route", health.defaultRoute ? "Yes" : "No — traffic may bypass the VPN"))
    }
  }
  if (rows.length > 0) rows.push(Shared.detail("Managed by", "awg-quick"))
  return rows
}

function activeAwgProfile(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i]
  }
  return null
}
