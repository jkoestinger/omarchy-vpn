import QtQuick
import Quickshell.Io
import "model/Shared.js" as Shared
import "model/Windscribe.js" as Windscribe

// Windscribe backend, driven by the `windscribe-cli` client talking to the
// Windscribe desktop app. Implements the backend contract documented in
// VpnController.qml.
//
// Three things make this one different from the other backends.
//
// The CLI takes a global lock, so no two invocations may overlap — every call
// goes through one queue and one process. See enqueue().
//
// Being installed is not being usable: the CLI is a client for an app you have
// to be logged into, so `detected` waits on the login state and not on the
// binary.
//
// And `connect` is run non-blocking, so it exits 0 the moment the request is
// accepted. The outcome arrives later, in the status line, and until it does a
// failure looks exactly like a success.
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "windscribe"
  readonly property string label: "Windscribe"
  readonly property var installNames: ["Windscribe"]
  readonly property string glyph: Shared.GLYPH_VPN
  readonly property bool supportsFilter: true
  // Cities and server nicknames match too, but the field is only so wide.
  readonly property string filterPlaceholder: "Filter locations — press / to search"

  property var status: Windscribe.parseWindscribeStatus("")
  property var locations: []
  property bool locationsLoaded: false
  property string actionStatus: ""
  property string lastError: ""

  property bool _present: false
  property bool _probed: false
  // The app is not answering — installed, but nothing behind the socket. What
  // the tool last said is kept rather than blanked, so this means "the reading
  // below is old", not "there is nothing to report".
  property bool _statusFailed: false
  // A reading has landed at least once, so `_statusFailed` describes something
  // going stale rather than a tool that has never answered.
  property bool _statusSeen: false

  // The binary alone says nothing: `windscribe-cli` is a client, and a client
  // nobody is logged into has no locations to offer and cannot connect. The
  // panel would otherwise draw a chip leading to an empty list.
  readonly property bool detected: _present && status.loggedIn

  readonly property string setupHint: {
    if (!_present) return ""
    if (_statusFailed && !_statusSeen) return "Windscribe is installed but its app is not answering. Start Windscribe, then reopen this panel."
    if (status.loaded && !status.loggedIn) return "Windscribe is installed but not logged in. Log in with: windscribe-cli login"
    return ""
  }

  // Windscribe's firewall is a kill switch: while it is on and the tunnel is
  // down, nothing leaves the machine at all — including the traffic another
  // backend's connect needs. An unreadable firewall line counts as "might be" —
  // see windscribeBlocksWhileDown.
  readonly property bool lockdownMode: detected && !connected && Windscribe.windscribeBlocksWhileDown(status)
  readonly property string lockdownHint: "windscribe-cli firewall off"

  // The one setting the CLI can change. Its value is always what the app last
  // reported; the widget stores no copy.
  readonly property var toggles: Shared.applyPendingToggles(Windscribe.windscribeToggles(status), _pendingToggles)
  property var _pendingToggles: ({})
  // Which switch is in flight, so a refusal rolls back the right one.
  property string _toggleKey: ""

  // Optimistic connection state so the switch flips the instant you click it.
  // -1 follows the app, 0/1 while a connect/disconnect is still in flight.
  property int _desired: -1

  readonly property bool connected: _desired === -1 ? status.connected : (_desired === 1)
  readonly property bool busy: _running !== "" || _queue.length > 0
  readonly property string summary: Windscribe.windscribeSummary(status)
  readonly property var details: Windscribe.windscribeDetails(status)
  readonly property var regions: Windscribe.windscribeRegions(locations)
  readonly property var favorites: Shared.favoriteCodes(setting("favoriteCountries", "CH,NL,US"))
  readonly property string emptyText: locationsLoaded ? "No locations match." : "Loading locations…"
  readonly property string currentKey: Windscribe.windscribeCurrentKey(status, regions)
  readonly property var targets: filter === ""
    ? Windscribe.windscribeQuickTargets(Windscribe.windscribeBestNickname(locations))
        .concat(Windscribe.windscribeRegionTargets(regions, favorites, ""))
    : Windscribe.windscribeRegionTargets(regions, favorites, filter)

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // ------------------------------------------------------------- the queue
  //
  // `windscribe-cli` holds a lock for as long as it runs. A second invocation
  // does not wait its turn and does not do the work — it exits saying
  // "Windscribe CLI is already running" and nothing else. Two calls started
  // together lose both answers, so a backend that polled status while fetching
  // locations would spend its life reading failures and hiding itself.
  //
  // So: one process, and one job at a time.
  //
  // That is only half of it. The lock is per machine and the widget is
  // instantiated once per monitor, so on a two-screen desktop there are two of
  // these queues, each disciplined and each unaware of the other. Ordering
  // within one instance is not enough — see the retry in onExited.
  property var _queue: []
  // The job on the wire, or null. Its `kind` is the only record of what is
  // running — two fields saying the same thing is two fields that can disagree.
  property var _current: null
  readonly property string _running: _current ? _current.kind : ""

  readonly property bool _actionPending: Windscribe.windscribePending(_queue, _running, ["connect", "disconnect"])
  readonly property bool _togglePending: Windscribe.windscribePending(_queue, _running, ["toggle"])

  function enqueue(kind, args) {
    var queue = Windscribe.windscribeEnqueue(_queue, _running, kind, args)
    if (queue === _queue) return
    _queue = queue
    pump()
  }

  function retry(job) {
    if (!Windscribe.windscribeCanRetry(job)) return false

    _queue = Windscribe.windscribeRequeue(_queue, job)
    retryTimer.interval = Windscribe.windscribeRetryDelay(job.attempts + 1, Math.random())
    retryTimer.restart()
    return true
  }

  Timer {
    id: retryTimer
    interval: 200
    repeat: false
    onTriggered: root.pump()
  }

  // Never starts a job while one is on the wire, and never arranges to be
  // called back for one either: the running job's onExited pumps, so a caller
  // who arrives mid-job can simply leave. An earlier version re-armed a
  // zero-interval timer here, which turned a hung CLI into a shell that spun
  // through the event loop for as long as the hang lasted.
  function pump() {
    if (_current !== null || cliProcess.running || _queue.length === 0) return

    var queue = _queue.slice()
    var job = queue.shift()
    _queue = queue
    _current = job
    cliProcess.command = ["windscribe-cli"].concat(job.args)
    cliProcess.running = true
    stallTimer.restart()
  }

  // Starting the next job from inside onExited would re-enter the process that
  // is still finishing, the same reason the other backends hop through a timer
  // to chain their two-step connects. The delay is small but not zero, so that
  // arriving a moment before the process reports finished costs one more tick
  // rather than a spin.
  Timer {
    id: pumpTimer
    interval: 50
    repeat: false
    onTriggered: root.pump()
  }

  // One job at a time only works while every job ends. A process that never
  // reports back would hold `_current` forever, and since a read already in
  // flight is never queued twice, the backend would stop asking about the
  // tunnel for as long as the shell ran while still presenting its last reading
  // as current.
  //
  // So the process is killed rather than forgotten. Forgetting it would leave
  // it holding the machine-wide lock — blocking every other monitor's copy of
  // this widget as well as this one — while `pump` refused to start anything
  // behind it. Killing it makes `onExited` fire, which does the bookkeeping by
  // the usual path. Nothing this CLI does takes half a minute.
  Timer {
    id: stallTimer
    interval: 30000
    repeat: false
    onTriggered: {
      root._current = null
      cliProcess.running = false
    }
  }

  // ------------------------------------------------------------ the verbs

  // Probing, and one status read, because the login state is the other half of
  // the answer to "is this tool here". Both are asked once: binaries do not
  // come and go while the shell runs, and `force` is the user asking again —
  // see refreshAll() in VpnController.
  function detect(force) {
    if (presenceProbe.running) return
    if (_probed && force !== true) return
    // `force` is the user asking again, which is the one moment the location
    // list could have gone stale in a way they can see: upgrading the account
    // turns "Pro only" rows into connectable ones, and nothing else would ever
    // re-read them.
    if (force === true) locationsLoaded = false
    presenceProbe.running = true
  }

  // Two hundred locations is a lot to fetch for a tool the user switched off,
  // and a hidden backend is given detect() alone. So the list is only ever
  // asked for on a path that started here.
  property bool _wantLocations: false

  function refresh() {
    if (!_present) return
    _wantLocations = true
    enqueue("status", ["status"])
    loadLocations()
  }

  function loadLocations() {
    if (!_wantLocations || !detected || locationsLoaded) return
    enqueue("locations", ["locations"])
  }

  function setToggle(key, value) {
    if (!detected || _togglePending) return

    var args = Windscribe.windscribeToggleArgs(key, value)
    if (args.length === 0) return

    var pending = {}
    for (var name in _pendingToggles) pending[name] = _pendingToggles[name]
    pending[key] = value
    _pendingToggles = pending

    lastError = ""
    _toggleKey = key
    enqueue("toggle", args)
    pendingTimer.restart()
  }

  // Connecting and disconnecting are allowed to move the firewall on their own:
  // with the app's firewall mode on `Auto` it goes on before a connect and off
  // after a disconnect. A switch still waiting to be agreed with would never be,
  // and the panel would end up accusing the tool of ignoring a setting it had
  // simply been told to change by something else.
  function forgetPendingToggles() {
    if (Object.keys(_pendingToggles).length === 0) return
    _pendingToggles = ({})
    pendingTimer.stop()
  }

  function clearPending(key) {
    var pending = {}
    for (var name in _pendingToggles) {
      if (name !== key) pending[name] = _pendingToggles[name]
    }
    _pendingToggles = pending
  }

  // `-n` returns as soon as the daemon accepts the request instead of blocking
  // for the length of the handshake. A blocking call would hold the CLI lock —
  // and with it every status read — for the five or ten seconds the tunnel
  // takes to come up, which is exactly the stretch the panel has something to
  // say. The settle timer polls for the outcome instead.
  function connectTo(target) {
    if (!detected || _actionPending || !target) return
    _desired = 1
    lastError = ""
    actionStatus = "Connecting to " + target.label + "…"
    forgetPendingToggles()
    enqueue("connect", ["connect", "-n"].concat(target.args || []))
  }

  function disconnect() {
    if (!detected || _actionPending) return
    _desired = 0
    lastError = ""
    actionStatus = "Disconnecting…"
    forgetPendingToggles()
    enqueue("disconnect", ["disconnect", "-n"])
  }

  function toggleConnection() {
    if (connected) disconnect()
    else connectTo({ label: "the best location", args: ["best"] })
  }

  // ------------------------------------------------------------- the state

  function applyStatus(raw) {
    var parsed = Windscribe.parseWindscribeStatus(raw)
    root.status = parsed

    // An accepted-then-failed connect is reported nowhere but here, so the
    // optimistic switch has to be dropped on sight of it. Left alone it would
    // stay on "connected" until the settle timer gave up, which is the widget
    // vouching for a tunnel that never came up.
    if (parsed.state === "error") root._desired = -1
    else if (root._desired !== -1 && parsed.connected === (root._desired === 1)) root._desired = -1

    // The CLI's error state is sticky — it stands until the next successful
    // connect — so this both raises the failure and clears it, rather than
    // only ever raising it.
    root.lastError = parsed.error !== "" ? Shared.elide(parsed.error, 140) : ""

    root.reconcileToggles(parsed)
    root.loadLocations()
  }

  // Drop the optimistic value only for the keys the app has since agreed with,
  // so a poll landing mid-flight cannot flick another switch back.
  function reconcileToggles(parsed) {
    var current = Windscribe.windscribeToggles(parsed)
    var pending = {}
    var changed = false

    for (var key in _pendingToggles) {
      var agreed = false
      for (var i = 0; i < current.length; i++) {
        if (current[i].key === key && current[i].value === _pendingToggles[key]) agreed = true
      }
      if (agreed) changed = true
      else pending[key] = _pendingToggles[key]
    }
    if (changed) _pendingToggles = pending
  }

  // A command that exits clean but does not take would otherwise leave the
  // switch showing the position the user asked for, marked busy, for as long as
  // the panel is open. Optimism gets a deadline.
  Timer {
    id: pendingTimer
    interval: 10000
    repeat: false
    onTriggered: {
      if (Object.keys(root._pendingToggles).length === 0) return
      root._pendingToggles = ({})
      root.lastError = "Windscribe did not apply that setting."
    }
  }

  // Longer than the other backends': `connect -n` hands back control before the
  // tunnel exists, and a Windscribe handshake takes several seconds. Giving up
  // early would drop the optimistic state onto a status that is still catching
  // up and flick the switch back under a connect that is going to succeed.
  Timer {
    id: settleTimer
    property int ticks: 0
    interval: 1500
    repeat: true
    running: false
    onTriggered: {
      settleTimer.ticks += 1
      root.refresh()
      if (settleTimer.ticks >= 8) {
        settleTimer.ticks = 0
        settleTimer.running = false
        root._desired = -1
      }
    }
  }

  // ---------------------------------------------------------- the processes

  // The only call that does not go through the queue, because it is not the
  // Windscribe CLI: `omarchy-cmd-present` takes no lock and answers instantly.
  Process {
    id: presenceProbe
    command: ["omarchy-cmd-present", "windscribe-cli"]
    running: true
    onExited: function(exitCode) {
      root._probed = true
      root._present = exitCode === 0
      // Login state takes a second command. Not refresh(): that would fetch the
      // location list for a tool the user may have hidden.
      if (root._present) root.enqueue("status", ["status"])
    }
  }

  Process {
    id: cliProcess
    running: false
    command: []
    stdout: StdioCollector { id: cliStdout; waitForEnd: true }
    stderr: StdioCollector { id: cliStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var job = root._current
      var kind = root._running
      var out = String(cliStdout.text || "")
      var err = String(cliStderr.text || "")

      stallTimer.stop()
      root._current = null

      // Somebody else had the lock. Nothing was read and nothing was done, so
      // this is not a result to act on — ask again in a moment. Usually the
      // somebody is this same widget on another monitor.
      if (job && root.cliLocked(out, err) && root.retry(job)) return

      if (kind === "status") root.finishStatus(exitCode, out, err)
      else if (kind === "locations") root.finishLocations(exitCode, out, err)
      else if (kind === "toggle") root.finishToggle(exitCode, out, err)
      else if (kind !== "") root.finishAction(exitCode, out, err)

      pumpTimer.restart()
    }
  }

  // Something else is holding the CLI lock. The call did no work and returned
  // no state, so nothing is concluded from it; the next poll asks again.
  function cliLocked(out, err) {
    return Windscribe.isWindscribeCliLocked(out) || Windscribe.isWindscribeCliLocked(err)
  }

  function finishStatus(exitCode, out, err) {
    var parsed = Windscribe.parseWindscribeStatus(out)

    if (exitCode !== 0 || !parsed.loaded) {
      if (root.cliLocked(out, err)) return

      // Nothing recognizable came back: the app is not running, or this is a
      // CLI whose output this parser does not know. The last reading is kept
      // and flagged stale rather than replaced with a blank one, for two
      // reasons that both bite hardest at exactly this moment.
      //
      // `detected` follows the login state, so blanking would take the chip
      // away while a tunnel is up — and with it the only way to bring that
      // tunnel down, since every verb here refuses to run undetected. It is the
      // hazard NetworkManagerBackend keeps its own stale list to avoid.
      //
      // And a blank status reports the firewall as off. Losing contact with the
      // app is precisely when the widget must not start claiming that nothing
      // is being blocked.
      root._statusFailed = true
      root.lastError = root._statusSeen
        ? "Windscribe is not answering — showing the last known state."
        : Shared.elide(err || out || "Could not read Windscribe status", 140)
      return
    }

    root._statusFailed = false
    root._statusSeen = true
    root.applyStatus(out)
  }

  // "Loaded" means asked and answered. A list this parser cannot read is a
  // reason to say so once, not to re-fetch two hundred lines on every poll for
  // as long as the shell runs.
  function finishLocations(exitCode, out, err) {
    // A refusal read as an empty list would latch `locationsLoaded` and the
    // error below for the life of the shell, since nothing re-fetches after a
    // successful-looking answer. Today's CLI prints the refusal on both
    // streams; this does not depend on that staying true.
    if (exitCode !== 0 || root.cliLocked(out, err)) return

    root.locations = Windscribe.parseWindscribeLocations(out)
    root.locationsLoaded = true
    if (root.locations.length === 0) {
      root.lastError = "Could not read the location list. Check: windscribe-cli locations"
    }
  }

  function finishAction(exitCode, out, err) {
    // A non-zero exit here means the request was refused outright — a location
    // name the daemon does not know, or a client that cannot reach the app. The
    // other kind of failure exits 0 and surfaces in the status line seconds
    // later, which is what the settle timer is watching for.
    if (exitCode !== 0 || root.cliLocked(out, err)) {
      root._desired = -1
      root.lastError = Shared.elide(err || out || "Windscribe command failed", 140)
    }
    root.actionStatus = ""
    settleTimer.ticks = 0
    settleTimer.restart()
    root.refresh()
  }

  function finishToggle(exitCode, out, err) {
    if (exitCode !== 0 || root.cliLocked(out, err)) {
      root.lastError = Shared.elide(err || out || "Windscribe refused that setting", 140)
      root.clearPending(root._toggleKey)
    }
    root._toggleKey = ""
    root.enqueue("status", ["status"])
  }
}
