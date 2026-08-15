.pragma library
.import "Shared.js" as Shared

// Windscribe, via `windscribe-cli`. Parsing, row-building, and the CLI queue
// reducer — the process plumbing lives in WindscribeBackend.qml.

// `windscribe-cli status` prints a plain-text block whose lines come and go
// with the state — `Protocol` only appears while a tunnel is up:
//
//   Internet connectivity: available
//   Login state: Logged in
//   Firewall state: On
//   Connect state: Connected: Zurich - Alphorn
//   Protocol: WireGuard:443
//   Data usage: 96.99 MB / 2.00 GB
//   Update available: 2.23.11
//
// So this matches on the leading key rather than on line position. Two values
// carry a colon of their own — `Connect state` and `Protocol` — which is why
// the split is on the first one only.
function parseWindscribeStatus(raw) {
  var result = {
    loaded: false,
    loggedIn: false,
    firewallKnown: false,
    firewallOn: false,
    firewallAlways: false,
    state: "",
    connected: false,
    location: "",
    city: "",
    nickname: "",
    protocol: "",
    port: "",
    dataUsed: "",
    dataLimit: "",
    interference: false,
    error: "",
    statusText: ""
  }

  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue

    var separator = line.indexOf(":")
    if (separator < 0) continue

    var key = line.substring(0, separator).trim().toLowerCase()
    var value = line.substring(separator + 1).trim()
    if (value === "") continue

    if (key === "login state") {
      result.loggedIn = /^logged in/i.test(value)
      result.loaded = true
    } else if (key === "firewall state") {
      // Three spellings, and only the two known ones are believed: reporting a
      // kill switch as off while it is on is the one mistake worth ruling out.
      var firewall = value.toLowerCase()
      if (firewall === "off") {
        result.firewallKnown = true
      } else if (firewall === "on" || firewall === "always on") {
        result.firewallKnown = true
        result.firewallOn = true
        result.firewallAlways = firewall === "always on"
      }
    } else if (key === "connect state") {
      applyWindscribeConnectState(result, value)
      result.loaded = true
    } else if (key === "protocol") {
      var protocol = value.split(":")
      result.protocol = protocol[0].trim()
      result.port = protocol.length > 1 ? protocol[1].trim() : ""
    } else if (key === "data usage") {
      var usage = value.split("/")
      result.dataUsed = usage[0].trim()
      result.dataLimit = usage.length > 1 ? usage[1].trim() : ""
    }
  }

  result.statusText = windscribeStateText(result)
  return result
}

// The value of `Connect state` is a sentence rather than an enum: "Connected:
// Zurich - Alphorn", "Connecting", "Error: Location does not exist or is
// disabled", or "Disconnected due to reaching WireGuard key limit. …".
//
// The error branch is not decoration. `windscribe-cli connect -n` exits 0 the
// moment the daemon accepts the request, so a connect that fails seconds later
// — a free account reaching for a Pro location, say — is reported here and
// nowhere else. The state is sticky: it stays until something succeeds.
function applyWindscribeConnectState(result, value) {
  var text = String(value || "").trim()

  // Appended to the connected state when the daemon sees the tunnel struggling.
  var interference = text.match(/^(.*?)\s*\[Network interference\]$/i)
  if (interference) {
    result.interference = true
    text = interference[1].trim()
  }

  var failure = text.match(/^error\s*:\s*(.+)$/i)
  if (failure) {
    result.state = "error"
    result.error = failure[1].trim()
    return
  }

  if (/^connecting\b/i.test(text)) {
    result.state = "connecting"
    applyWindscribeLocation(result, afterFirstColon(text))
    return
  }
  if (/^connected\b/i.test(text)) {
    result.state = "connected"
    result.connected = true
    applyWindscribeLocation(result, afterFirstColon(text))
    return
  }
  if (/^disconnecting\b/i.test(text)) {
    result.state = "disconnecting"
    return
  }
  if (/^disconnected\b/i.test(text)) {
    result.state = "disconnected"
    // "Disconnected due to reaching WireGuard key limit. Use …" is a disconnect
    // with a reason attached, and the reason is the half worth reading.
    if (!/^disconnected$/i.test(text)) result.error = text
  }
}

function afterFirstColon(text) {
  var separator = String(text || "").indexOf(":")
  return separator < 0 ? "" : text.substring(separator + 1).trim()
}

// `status` names the connected location as "City - Nickname", one segment
// shorter than the three-part form `locations` prints, so the nickname is taken
// from the end rather than from a fixed position.
function applyWindscribeLocation(result, text) {
  var location = String(text || "").trim()
  if (location === "") return

  result.location = location
  var parts = location.split(" - ")
  result.nickname = parts[parts.length - 1].trim()
  if (parts.length > 1) result.city = parts[parts.length - 2].trim()
}

function windscribeStateText(status) {
  if (!status.loaded) return "Unknown"
  if (!status.loggedIn) return "Not logged in"
  if (status.state === "connected") return "Connected"
  if (status.state === "connecting") return "Connecting"
  if (status.state === "disconnecting") return "Disconnecting"
  if (status.state === "error") return "Not connected"
  if (status.state === "disconnected") return "Disconnected"
  return "Unknown"
}

function windscribeLocation(status) {
  if (status.nickname !== "" && status.city !== "") return status.nickname + " · " + status.city
  if (status.nickname !== "") return status.nickname
  return status.city
}

function windscribeSummary(status) {
  if (!status.loaded) return "Checking…"
  if (!status.loggedIn) return "Not logged in"

  if (status.state === "connected") {
    var place = windscribeLocation(status)
    var line = place !== "" ? place : "Connected"
    return status.interference ? line + " · network interference" : line
  }
  if (status.state === "connecting") {
    var target = windscribeLocation(status)
    return target !== "" ? "Connecting to " + target + "…" : "Connecting…"
  }
  if (status.state === "disconnecting") return "Disconnecting…"
  // The failure itself goes to lastError, which is where the panel puts the
  // things a user has to act on; the summary only says where that leaves them.
  if (status.state === "error") return status.firewallOn ? "Not connected · traffic blocked" : "Not connected"
  if (status.state === "disconnected") return status.firewallOn ? "Not connected · traffic blocked" : "Not connected"
  return "Checking…"
}

function windscribeDetails(status) {
  if (status.state !== "connected") return []

  var rows = [Shared.detail("Server", status.nickname), Shared.detail("Location", status.city)]
  if (status.protocol !== "") {
    rows.push(Shared.detail("Protocol", status.port !== "" ? status.protocol + " · " + status.port : status.protocol))
  }
  // Windscribe meters the free plan, and the number is only ever printed here.
  if (status.dataUsed !== "") {
    rows.push(Shared.detail("Data used", status.dataLimit !== "" ? status.dataUsed + " of " + status.dataLimit : status.dataUsed))
  }
  if (status.interference) rows.push(Shared.detail("Network", "Interference detected"))
  return rows.filter(function(row) { return row.value !== "" })
}

// `windscribe-cli locations` prints one location per line:
//
//   Best Location - Alphorn (10 Gbps)
//   US Central - Atlanta - Magic City (Pro) (10 Gbps)
//   Switzerland - Zurich - Alphorn (10 Gbps)
//
// Region, city and nickname are joined with " - ", and the trailing groups
// describe the entry rather than name it. Only the markers the CLI actually
// prints are stripped, so a nickname that happens to end in brackets keeps
// them.
function parseWindscribeLocations(raw) {
  var locations = []
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    // `locations static` prefixes a device-name line and both variants say so
    // when there is nothing to list.
    if (line === "" || line === "No locations." || line.indexOf("(Device name:") === 0) continue

    var pro = false
    var disabled = false
    var text = line

    for (;;) {
      var marker = text.match(/\s*\((Pro|Disabled|[^()]*Gbps)\)$/i)
      if (marker) {
        var name = marker[1].toLowerCase()
        if (name === "pro") pro = true
        else if (name === "disabled") disabled = true
        text = text.substring(0, text.length - marker[0].length)
        continue
      }
      // The CLI puts a static IP's device name in brackets.
      var bracket = text.match(/\s*\[[^\[\]]*\]$/)
      if (!bracket) break
      text = text.substring(0, text.length - bracket[0].length)
    }

    var parts = text.split(" - ")
    for (var p = 0; p < parts.length; p++) parts[p] = parts[p].trim()

    var nickname = parts[parts.length - 1]
    if (nickname === "") continue

    locations.push({
      region: parts.length > 1 ? parts[0] : "",
      city: parts.length > 2 ? parts.slice(1, parts.length - 1).join(" - ") : "",
      nickname: nickname,
      pro: pro,
      disabled: disabled
    })
  }
  return locations
}

// The first row is the pseudo-location the daemon resolves "best" to. It names
// a server rather than a place, so it belongs on the quick row and not in the
// region list.
function isWindscribeBestRow(location) {
  return String(location.region || "").toLowerCase() === "best location"
}

function windscribeBestNickname(locations) {
  for (var i = 0; i < locations.length; i++) {
    if (isWindscribeBestRow(locations[i])) return locations[i].nickname
  }
  return ""
}

// Windscribe's own top-level grouping — a country most of the time, a slice of
// one ("US East") where a country has too many. `connect` takes a region name
// directly, so the row needs nothing beyond its name to be connectable, and
// the daemon picks a datacenter inside it.
function windscribeRegions(locations) {
  var regions = []
  var index = {}

  for (var i = 0; i < locations.length; i++) {
    var location = locations[i]
    if (isWindscribeBestRow(location) || location.disabled || location.region === "") continue
    // The name is handed to `windscribe-cli connect` as an argument. No shell is
    // involved, so there is nothing to inject, but a name starting with a dash
    // would be read as an option rather than as a place. No such region exists;
    // a row that claimed to be one would not be a region either.
    if (location.region.charAt(0) === "-") continue

    var key = location.region.toLowerCase()
    var region = index[key]
    if (!region) {
      region = { name: location.region, cities: [], nicknames: [], free: 0, total: 0 }
      index[key] = region
      regions.push(region)
    }

    if (location.city !== "" && region.cities.indexOf(location.city) < 0) region.cities.push(location.city)
    region.nicknames.push(location.nickname)
    region.total += 1
    if (!location.pro) region.free += 1
  }
  return regions
}

// A free account cannot reach a Pro location, and the CLI's refusal — "Location
// does not exist or is disabled" — does not say which of the two it meant. Say
// it on the row instead of letting the connect fail to explain itself.
function windscribeRegionDetail(region) {
  var parts = []
  if (region.cities.length > 0) {
    parts.push(region.cities.length + (region.cities.length === 1 ? " city" : " cities"))
  }
  if (region.free === 0) parts.push("Pro only")
  return parts.join(" · ")
}

// Windscribe names its regions and never prints a country code, so the
// favorites setting is matched by name — "Switzerland" — and by leading word,
// which is what makes "US" pick up US East, US Central and US West.
function isWindscribeFavorite(name, favorites) {
  if (!favorites || favorites.length === 0) return false

  var region = String(name || "").toUpperCase()
  var head = region.split(" ")[0]
  for (var i = 0; i < favorites.length; i++) {
    if (favorites[i] === region || favorites[i] === head) return true
  }
  return false
}

// `connect` with no location reuses the last one, which is the same row the
// user just clicked; "best" is the only quick answer worth its own row.
function windscribeQuickTargets(bestNickname) {
  var nickname = String(bestNickname || "")
  return [
    {
      key: "best",
      label: "Best location",
      detail: nickname !== "" ? "Currently " + nickname : "Let Windscribe pick",
      glyph: Shared.GLYPH_BOLT,
      args: ["best"]
    }
  ]
}

function windscribeRegionTargets(regions, favorites, filter) {
  var needle = String(filter || "").trim().toLowerCase()
  var favored = []
  var rest = []

  for (var i = 0; i < regions.length; i++) {
    var region = regions[i]
    if (needle !== "") {
      // Nicknames are in the haystack because they are what the CLI reports
      // back while connected, so "alphorn" finds the row it will tick.
      var haystack = (region.name + " " + region.cities.join(" ") + " "
        + region.nicknames.join(" ")).toLowerCase()
      if (haystack.indexOf(needle) < 0) continue
    }

    var target = {
      key: "region:" + region.name.toLowerCase(),
      label: region.name,
      detail: windscribeRegionDetail(region),
      glyph: Shared.GLYPH_VPN,
      args: [region.name]
    }
    if (needle === "" && isWindscribeFavorite(region.name, favorites)) favored.push(target)
    else rest.push(target)
  }

  return favored.concat(rest)
}

// The status line names a city and a nickname but never the region, so the row
// to tick is found by looking the connected server back up in the list. City
// first, across every region, because a nickname is a joke and a city is not:
// two regions sharing a nickname is likelier than two sharing a city.
function windscribeCurrentKey(status, regions) {
  if (status.state !== "connected" && status.state !== "connecting") return ""

  var city = String(status.city || "").toLowerCase()
  var nickname = String(status.nickname || "").toLowerCase()
  var i = 0
  var n = 0

  if (city !== "") {
    for (i = 0; i < regions.length; i++) {
      for (n = 0; n < regions[i].cities.length; n++) {
        if (regions[i].cities[n].toLowerCase() === city) return "region:" + regions[i].name.toLowerCase()
      }
    }
  }
  if (nickname !== "") {
    for (i = 0; i < regions.length; i++) {
      for (n = 0; n < regions[i].nicknames.length; n++) {
        if (regions[i].nicknames[n].toLowerCase() === nickname) return "region:" + regions[i].name.toLowerCase()
      }
    }
  }
  return ""
}

// One switchable setting: the firewall, which is Windscribe's kill switch.
// Everything else lives in the desktop app's preferences file, which this
// widget reads nothing from and writes nothing to.
function windscribeToggles(status) {
  if (!status || !status.firewallKnown) return []

  return [
    Shared.toggle("firewall", "Firewall",
      status.firewallAlways
        ? "Always on — change it in the Windscribe app"
        : "Block traffic outside the tunnel",
      status.firewallOn)
  ]
}

function windscribeToggleArgs(key, value) {
  if (key === "firewall") return ["firewall", value ? "on" : "off"]
  return []
}

// `windscribe-cli` holds a lock for as long as it runs, and a second
// invocation does not wait its turn: it prints this and exits without doing
// the work. The backend serialises its own calls, so seeing it means something
// outside the widget is talking to the app — the user at a terminal, or this
// same widget on another monitor, since each bar instantiates it separately.
// It is not an answer about the tunnel, and nothing should be concluded from
// it.
function isWindscribeCliLocked(text) {
  return /already running/i.test(String(text || ""))
}

// The firewall is a kill switch, and `lockdownMode` is read to decide whether
// to warn someone that switching tools will not get through. "The tool never
// said" has to weigh the same as "the tool said yes": the cost of a warning
// nobody needed is a sentence, and the cost of the missing one is a connect
// that fails for reasons the panel had already been told about and forgot.
//
// The summary line deliberately does not use this — it states what the tool
// reported, and an unrecognised firewall line is not a report that traffic is
// blocked. One weighs a risk, the other states a fact.
function windscribeBlocksWhileDown(status) {
  if (!status || !status.loaded) return false
  return status.firewallOn || !status.firewallKnown
}

// --------------------------------------------------- Windscribe call queue
//
// Because two `windscribe-cli` invocations may not overlap, every call the
// backend makes is a job in a queue of one runner. The rules are here rather
// than in the QML so they can be tested: this is a reducer over (queue,
// running job), not process plumbing, and it is the part that has been wrong.

var WINDSCRIBE_MAX_ATTEMPTS = 4

// Reads answer a question; actions change something. That is the whole
// difference the queue cares about.
function isWindscribeReadJob(kind) {
  return kind === "status" || kind === "locations"
}

// Reads are idempotent, so a second one waiting behind the first is a stale
// answer nobody asked for: the poll fires faster than the CLI replies, and a
// backlog of them would keep the panel a cycle behind for as long as the shell
// ran. A click goes to the front, because waiting out a two-hundred line
// location fetch is not what "connect" should feel like.
//
// Returns the queue unchanged when the job is a duplicate read.
function windscribeEnqueue(queue, runningKind, kind, args) {
  var next = queue.slice()
  var job = { kind: kind, args: args, attempts: 0 }

  if (!isWindscribeReadJob(kind)) {
    next.unshift(job)
    return next
  }

  if (runningKind === kind) return queue
  for (var i = 0; i < next.length; i++) {
    if (next[i].kind === kind) return queue
  }
  next.push(job)
  return next
}

// A job that lost the lock goes back to the head of its own queue, one attempt
// older. A fresh object rather than a mutated one, so nothing that captured the
// old job sees its attempt count move underneath it.
function windscribeRequeue(queue, job) {
  var next = queue.slice()
  next.unshift({ kind: job.kind, args: job.args, attempts: job.attempts + 1 })
  return next
}

// Bounded, because a lock held by something that is never going to let go is
// not worth knocking on forever. Past the last attempt the job runs its
// finisher, which treats a refusal as inconclusive rather than as news.
function windscribeCanRetry(job) {
  return !!job && job.attempts < WINDSCRIBE_MAX_ATTEMPTS
}

// The jitter is not decoration. Two widget instances that started together lose
// together — that is what a shared lock and a shared poll interval do — and
// backing off by the same amount would have them collide again on every round.
// Something has to break the tie, and the attempt count cannot: it is identical
// on both sides. `roll` is a 0..1 draw, passed in so this stays testable.
function windscribeRetryDelay(attempts, roll) {
  var draw = Number(roll)
  if (!isFinite(draw) || draw < 0) draw = 0
  if (draw > 1) draw = 1
  return 120 * attempts + Math.floor(draw * 280)
}

// Whether a job of any of these kinds is running or waiting — what stops a
// second click landing on top of the first.
function windscribePending(queue, runningKind, kinds) {
  if (kinds.indexOf(runningKind) >= 0) return true
  for (var i = 0; i < queue.length; i++) {
    if (kinds.indexOf(queue[i].kind) >= 0) return true
  }
  return false
}
