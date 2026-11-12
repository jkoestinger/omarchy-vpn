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
// stricter builds, reject). None of that reaches this file: from here a profile
// is a path, a hooks flag and an endpoint.

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

// One config line as awg-quick itself reads it. Its parser (inherited verbatim
// from wg-quick) is:
//
//     stripped="${line%%\#*}"
//     key="${stripped%%=*}"; key="${key##*([[:space:]])}"; key="${key%%*([[:space:]])}"
//
// so a `#` starts a comment anywhere in the line, not only at column 0, and the
// key is whatever is left once the text before the first `=` is trimmed. A `;`
// starts no comment at all: `;PostUp = x` is a key named ";PostUp", which
// matches no directive and is therefore inert. Matching is done under
// `shopt -s nocasematch`, so `postup =` is every bit as much a hook as
// `PostUp =`.
//
// The line reaches that parser through bash's `read`, which drops NUL bytes
// without a word, so `Post<NUL>Up =` is a hook to awg-quick. Kept here, the
// byte made the key "post\0up", and a root hook went through as harmless.
function confDirective(line) {
  var stripped = String(line || "").replace(/\u0000/g, "").split("#")[0]
  var eq = stripped.indexOf("=")
  if (eq < 0) return null
  var key = stripped.substring(0, eq).trim()
  if (key === "") return null
  return { key: key.toLowerCase(), value: stripped.substring(eq + 1).trim() }
}

// A PreUp/PostUp/PreDown/PostDown line runs as root the moment awg-quick brings
// the interface up or down — the same hazard a plain WireGuard profile carries,
// and one a dropped-in `.conf` file is exactly the way to hide. Profiles
// carrying one are listed but refused at connect time rather than silently
// stripped, so the user sees why rather than wondering why nothing happened.
//
// awg-quick only honours these inside `[Interface]`; this ignores sections and
// blocks the profile wherever the line appears, erring towards refusing one the
// tool would have ignored rather than running one it would have executed.
function hasDangerousHooks(confText) {
  var lines = String(confText || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var directive = confDirective(lines[i])
    if (!directive) continue
    if (directive.key === "preup" || directive.key === "postup"
        || directive.key === "predown" || directive.key === "postdown") return true
  }
  return false
}

// Everything the panel needs to know about one profile, read from the config
// itself: whether connecting to it would run root hooks, where it goes, and
// whether it carries the default route. A config can hold several `[Peer]`
// blocks, so endpoints is a list.
function parseConf(confText) {
  var lines = String(confText || "").split("\n")
  var endpoints = []
  var defaultRoute = false
  for (var i = 0; i < lines.length; i++) {
    var directive = confDirective(lines[i])
    if (!directive) continue
    if (directive.key === "endpoint") {
      if (directive.value !== "" && endpoints.indexOf(directive.value) < 0) endpoints.push(directive.value)
    } else if (directive.key === "allowedips") {
      var cidrs = directive.value.split(",")
      for (var j = 0; j < cidrs.length; j++) {
        var cidr = cidrs[j].trim()
        if (cidr === "0.0.0.0/0" || cidr === "::/0") defaultRoute = true
      }
    }
  }
  return { hasHooks: hasDangerousHooks(confText), endpoints: endpoints, defaultRoute: defaultRoute }
}

// The backend's listProcess concatenates every readable profile into one
// stream: a `#awg-profile <path>` header at column 0, then that file's lines
// each indented by one tab. The indent is what keeps a config that happens to
// contain a line looking like a header from opening a record of its own.
function parseProfileBundle(raw) {
  var entries = []
  var current = null
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.indexOf("#awg-profile ") === 0) {
      var path = line.substring("#awg-profile ".length).trim()
      if (path === "") { current = null; continue }
      current = { path: path, text: [] }
      entries.push(current)
      continue
    }
    if (current && line.indexOf("\t") === 0) current.text.push(line.substring(1))
  }

  var profiles = []
  for (var k = 0; k < entries.length; k++) {
    var conf = parseConf(entries[k].text.join("\n"))
    profiles.push({
      path: entries[k].path,
      hasHooks: conf.hasHooks,
      endpoints: conf.endpoints,
      defaultRoute: conf.defaultRoute
    })
  }
  return profiles
}

// The config basename is the interface name awg-quick would bring up — same
// rule wg-quick uses, since awg-quick is a fork of it.
function interfaceFor(confFile) {
  var base = String(confFile || "").replace(/\\/g, "/").split("/").pop()
  return base.replace(/\.conf$/i, "")
}

// The profile list the panel renders: every config found, plus one synthesized
// row per interface that is up and has no config behind it.
//
// That second half matters more than it looks. awg-quick's own profile
// directory is /etc/amnezia/amneziawg, root-owned and unreadable to the user
// the shell runs as, so a tunnel started with `sudo awg-quick up work` is up
// with nothing in the listing to match it. Without a row for it the backend is
// undetected, the chip is gone, and the tunnel that is carrying the user's
// traffic cannot be brought down from the panel. The same hole opens when a
// config is deleted or renamed while its tunnel is up — a listing that cannot
// see a profile is stale, not proof the tunnel ended. awg-quick resolves a bare
// interface name against its own directory, so `awg-quick down work` takes it
// down without the widget ever having read the file.
function buildProfiles(entries, upInterfaces) {
  var up = upInterfaces || []
  var profiles = []
  var seen = {}
  for (var i = 0; i < entries.length; i++) {
    var name = interfaceFor(entries[i].path)
    if (name === "" || seen[name]) continue
    seen[name] = true
    profiles.push({
      name: name,
      confFile: entries[i].path,
      hasHooks: entries[i].hasHooks === true,
      endpoints: entries[i].endpoints || [],
      defaultRoute: entries[i].defaultRoute === true,
      external: false,
      active: up.indexOf(name) !== -1
    })
  }
  for (var j = 0; j < up.length; j++) {
    if (seen[up[j]]) continue
    seen[up[j]] = true
    profiles.push({
      name: up[j],
      confFile: up[j],
      hasHooks: false,
      endpoints: [],
      defaultRoute: false,
      external: true,
      active: true
    })
  }
  return profiles
}

// One line per up interface, "<iface>\t<rxBytes>\t<txBytes>", built by the
// backend from /sys/class/net counters (see AmneziaWgBackend.qml's
// healthProcess). `wg`/`awg` keep per-peer stats behind root, so the sysfs
// counters are what a normal user can read without elevating just to watch
// throughput.
function parseSysfsStats(raw) {
  var health = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    var fields = line.split("\t")
    var iface = String(fields[0] || "").trim()
    if (iface === "") continue
    health[iface] = {
      rxBytes: parseInt(fields[1], 10) || 0,
      txBytes: parseInt(fields[2], 10) || 0
    }
  }
  return health
}

// Turn two byte counters into the rates the detail rows show, and decide what
// to keep when a sample comes back empty.
//
// The inner `awg show interfaces` in healthProcess exits 0 whether it found
// interfaces or failed to, so an empty read is indistinguishable from "nothing
// is up" at the shell. Taking it at face value blanks the throughput rows of a
// connection the rest of the panel still reports as up. An empty sample is
// therefore treated the way a failed status read is: stale, not empty. It is
// also reported as unsampled, so the caller leaves its sample clock alone and
// the next real reading divides its byte delta by the whole elapsed interval
// rather than by the gap since a sample that never happened.
function mergeHealth(previous, next, elapsedSeconds) {
  var prior = previous || {}
  var empty = true
  for (var key in next) { empty = false; break }
  if (empty) return { health: prior, sampled: false }

  var elapsed = Number(elapsedSeconds) || 0
  for (var iface in next) {
    var before = prior[iface]
    if (!before || elapsed <= 0) continue
    next[iface].rxRate = Math.max(0, next[iface].rxBytes - before.rxBytes) / elapsed
    next[iface].txRate = Math.max(0, next[iface].txBytes - before.txBytes) / elapsed
  }
  return { health: next, sampled: true }
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

function awgTargets(profiles) {
  var targets = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    var detailText = "AmneziaWG profile"
    if (profile.hasHooks) detailText = "Blocked: contains root hooks"
    else if (profile.external) detailText = profile.active ? "Connected · started outside the widget" : "Started outside the widget"
    else if (profile.active) detailText = "Connected"
    targets.push({
      key: "profile:" + profile.name,
      label: profile.name,
      detail: detailText,
      glyph: profile.hasHooks ? Shared.GLYPH_SHIELD_LOCK : Shared.GLYPH_SHIELD,
      confFile: profile.confFile,
      active: profile.active === true,
      external: profile.external === true,
      hasHooks: profile.hasHooks === true,
      // Part of the target contract: the panel draws a blocked row dimmed, so a
      // profile that cannot be connected does not look like one that can.
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
    var profile = profiles[i]
    if (!profile.active) continue
    var iface = interfaceFor(profile.confFile)
    var health = healthByInterface ? healthByInterface[iface] : null
    rows.push(Shared.detail("Profile", profile.name))
    rows.push(Shared.detail("Interface", iface))
    // An externally started tunnel has a config this widget never read, so the
    // rows that come from one are left out rather than guessed at.
    if (!profile.external) {
      if (profile.endpoints && profile.endpoints.length > 0) {
        rows.push(Shared.detail("Endpoint", profile.endpoints.join(", ")))
      }
      rows.push(Shared.detail("Default route", profile.defaultRoute ? "Yes" : "No — traffic may bypass the VPN"))
    }
    if (health) {
      rows.push(Shared.detail("Receiving", formatRate(health.rxRate || 0)))
      rows.push(Shared.detail("Sending", formatRate(health.txRate || 0)))
      rows.push(Shared.detail("Downloaded", formatBytes(health.rxBytes)))
      rows.push(Shared.detail("Uploaded", formatBytes(health.txBytes)))
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
