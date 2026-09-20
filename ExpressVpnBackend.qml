import QtQuick
import Quickshell.Io
import "model/Shared.js" as Shared
import "model/ExpressVpn.js" as ExpressVpn

// ExpressVPN backend, driven by `expressvpnctl` talking to its daemon.
// Implements the backend contract documented in VpnController.qml.
//
// Two things shape this one.
//
// The CLI is a client for a daemon that only answers when the ExpressVPN app
// is running or background mode is enabled — being installed is not being
// usable, so `detected` waits on a probe that can actually talk to the
// daemon, and the two ways that probe can fail (signed out, background mode
// off) are setup states, not errors.
//
// And every read and write is a short Rust-binary call, so unlike Proton
// there is no reason to ration them. The status is polled; the region list is
// latched, because it only changes when the account or the app does.
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "expressvpn"
  readonly property string label: "ExpressVPN"
  readonly property var installNames: ["ExpressVPN"]
  readonly property string glyph: ExpressVpn.GLYPH_EXPRESSVPN
  readonly property bool supportsFilter: true
  // Countries match, and so do the cities the region list carries.
  readonly property string filterPlaceholder: "Filter locations — press / to search"

  property var status: ExpressVpn.parseExpressStatus("")
  property var regions: []
  property bool regionsLoaded: false
  property var networkLock: ExpressVpn.parseNetworkLock("")
  property string actionStatus: ""
  property string lastError: ""

  property bool _present: false
  property bool _probed: false
  property bool _needsLogin: false
  property bool _needsBackground: false
  // The daemon is not answering — installed, but nothing behind the socket.
  // What the tool last said is kept rather than blanked, so this means "the
  // reading below is old", not "there is nothing to report".
  property bool _statusFailed: false
  property bool _statusSeen: false

  // The binary alone says nothing: a CLI nobody is signed into, or one whose
  // daemon refuses until background mode is enabled or the app is running,
  // has no regions to offer and cannot connect. The panel would otherwise
  // draw a chip leading to an empty list.
  readonly property bool detected: _present && _usable

  // A probe that reached the daemon and got answers is what makes the chip
  // appear. Signed out and background-off are the two named ways it refuses;
  // anything else keeps the last verdict rather than flapping.
  property bool _usable: false

  readonly property var _probe: ({
    present: _present,
    needsLogin: _needsLogin,
    needsBackground: _needsBackground,
    // Present, but nothing the parser could ever read: the fallback state,
    // so the panel names what to check rather than telling the user to
    // install the thing they already have.
    needsStatusCheck: _statusFailed && !_statusSeen
  })
  readonly property string setupHint: ExpressVpn.expressSetupHint(_probe)
  readonly property string setupCommand: ExpressVpn.expressSetupCommand(_probe)

  // Network Lock is ExpressVPN's kill switch, and it is on by default. No
  // `lockdownMode` here, deliberately: the default mode blocks traffic when a
  // tunnel drops unexpectedly, and whether the stricter "at all times" variant
  // — the one that would swallow another backend's connect — is set is not
  // something the CLI reports. Claiming a block the tool never announced would
  // warn on every teardown of an ordinary kill switch.
  //
  // The one setting the CLI can change. Its value is always what the daemon
  // last reported; the widget stores no copy.
  readonly property var toggles: Shared.applyPendingToggles(ExpressVpn.expressToggles(networkLock), _pendingToggles)
  property var _pendingToggles: ({})
  property string _toggleKey: ""

  // Optimistic connection state so the switch flips the instant you click it.
  // -1 follows the daemon, 0/1 while a connect/disconnect is still in flight.
  property int _desired: -1

  readonly property bool connected: _desired === -1 ? status.connected : (_desired === 1)
  readonly property bool busy: _working || statusProcess.running
  readonly property string summary: ExpressVpn.expressSummary(status)
  readonly property var details: ExpressVpn.expressDetails(status)
  readonly property var favorites: Shared.favoriteCodes(setting("favoriteCountries", "CH,NL,US"))
  readonly property string emptyText: regionsLoaded ? "No locations match." : "Loading locations…"
  readonly property string currentKey: ExpressVpn.expressCurrentKey(status, regions)
  readonly property var targets: filter === ""
    ? ExpressVpn.expressQuickTargets(status).concat(ExpressVpn.expressTargets(regions, favorites, ""))
    : ExpressVpn.expressTargets(regions, favorites, filter)

  // What connectTo() is in the middle of: only connect, since the region is
  // part of the one call — no mode step, unlike WARP's two-stage chain.
  property bool _working: false

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // ------------------------------------------------------------- the verbs

  // Probing, and nothing else — a hidden backend is given detect() alone. The
  // usability question takes a real command, so the probe doubles as it.
  function detect(force) {
    if (presenceProbe.running) return
    if (_probed && force !== true) return
    // `force` is the user asking again, which is the one moment the region
    // list could have gone stale in a way they can see: new servers, or an
    // account change. Nothing else re-reads it.
    if (force === true) regionsLoaded = false
    presenceProbe.running = true
  }

  function refresh() {
    if (!_present || !_usable) return
    if (!statusProcess.running) statusProcess.running = true
    if (!lockProcess.running) lockProcess.running = true
    loadRegions()
  }

  // Two hundred regions is a lot to fetch for a tool the user switched off,
  // and a hidden backend is given detect() alone. So the list is only ever
  // asked for on a path that started here.
  function loadRegions() {
    if (!detected || regionsLoaded) return
    if (regionsProcess.running) return
    regionsProcess.running = true
  }

  function setToggle(key, value) {
    if (!detected || _working) return

    var args = ExpressVpn.expressToggleArgs(key, value)
    if (args.length === 0) return

    var pending = {}
    for (var name in _pendingToggles) pending[name] = _pendingToggles[name]
    pending[key] = value
    _pendingToggles = pending

    lastError = ""
    _toggleKey = key
    runCommand("toggle", args)
    pendingTimer.restart()
  }

  function connectTo(target) {
    if (!detected || _working || !target) return

    _desired = 1
    lastError = ""
    actionStatus = "Connecting to " + target.label + "…"
    runCommand("connect", ["connect"].concat(target.args || []))
  }

  function disconnect() {
    if (!detected || _working) return
    _desired = 0
    lastError = ""
    actionStatus = "Disconnecting…"
    runCommand("disconnect", ["disconnect"])
  }

  // ExpressVPN's own default: bare `connect` uses the Smart Location, or
  // reconnects to the most recent region — the tool's own idea.
  function toggleConnection() {
    if (connected) {
      disconnect()
      return
    }
    if (!detected || _working) return

    _desired = 1
    lastError = ""
    actionStatus = "Connecting…"
    runCommand("connect", ["connect"])
  }

  function runCommand(kind, args) {
    root._working = true
    root._currentKind = kind
    commandProcess.command = ["expressvpnctl"].concat(args)
    commandProcess.running = true
  }

  function applyStatus(raw) {
    var parsed = ExpressVpn.parseExpressStatus(raw)
    // An answer that does not parse is not news. Keep the last reading, so a
    // hiccup cannot report a live tunnel as down — and with it the only way
    // to bring that tunnel down, since every verb refuses to run undetected.
    if (!ExpressVpn.statusLoaded(parsed)) return
    root.status = parsed
    if (_desired !== -1 && parsed.connected === (_desired === 1)) _desired = -1
  }

  // Drop the optimistic value only for the keys the daemon has since agreed
  // with, so a poll landing mid-flight cannot flick another switch back.
  function reconcileToggles(lock) {
    var current = ExpressVpn.expressToggles(lock)
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
  // switch showing the position the user asked for, marked busy, for as long
  // as the panel is open. Optimism gets a deadline.
  Timer {
    id: pendingTimer
    interval: 10000
    repeat: false
    onTriggered: {
      if (Object.keys(root._pendingToggles).length === 0) return
      root._pendingToggles = ({})
      root.lastError = "ExpressVPN did not apply that setting."
    }
  }

  // The daemon applies connect and disconnect a beat after the command
  // returns, so poll for a little while before trusting the answer.
  Timer {
    id: settleTimer
    property int ticks: 0
    interval: 1000
    repeat: true
    running: false
    onTriggered: {
      settleTimer.ticks += 1
      root.refresh()
      if (settleTimer.ticks >= 10) {
        settleTimer.ticks = 0
        settleTimer.running = false
        root._desired = -1
      }
    }
  }

  // ---------------------------------------------------------- the processes

  // The presence probe is a real read, not just a lookup of the binary: the
  // daemon answers only when the app is running or background mode is on, and
  // its refusal names which of the two setup states applies. A probe that
  // cannot run at all keeps the last verdict — a stopped daemon mid-session
  // shows its error on the chip instead of taking the chip away.
  Process {
    id: presenceProbe
    command: ["omarchy-cmd-present", "expressvpnctl"]
    running: true
    onExited: function(exitCode) {
      root._probed = true
      root._present = exitCode === 0
      if (root._present) root.probeUsability()
    }
  }

  function probeUsability() {
    if (statusProcess.running) return
    statusProcess.running = true
  }

  Process {
    id: statusProcess
    running: false
    command: ["expressvpnctl", "status"]
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var out = String(statusStdout.text || "")
      var err = String(statusStderr.text || "")

      if (exitCode === 0) {
        var parsed = ExpressVpn.parseExpressStatus(out)
        if (ExpressVpn.statusLoaded(parsed)) {
          root._usable = true
          root._needsLogin = false
          root._needsBackground = false
          root._statusFailed = false
          root._statusSeen = true
          root.applyStatus(out)
          if (!root.regionsLoaded) root.loadRegions()
          return
        }
      }

      // A named refusal is a setup state, not a broken tool.
      if (ExpressVpn.isExpressSignedOut(err) || ExpressVpn.isExpressSignedOut(out)) {
        root._usable = false
        root._needsLogin = true
        root._needsBackground = false
        root._statusFailed = false
        return
      }
      if (ExpressVpn.isExpressBackgroundOff(err) || ExpressVpn.isExpressBackgroundOff(out)) {
        root._usable = false
        root._needsLogin = false
        root._needsBackground = true
        root._statusFailed = false
        return
      }

      // Stale, not empty: say what went wrong and leave the last reading up.
      root._statusFailed = true
      root.lastError = root._statusSeen
        ? "ExpressVPN is not answering — showing the last known state."
        : Shared.elide(err || out || "Could not read ExpressVPN status", 140)
    }
  }

  Process {
    id: regionsProcess
    running: false
    command: ["expressvpnctl", "get", "regions"]
    stdout: StdioCollector { id: regionsStdout; waitForEnd: true }
    stderr: StdioCollector { id: regionsStderr; waitForEnd: true }
    onExited: function(exitCode) {
      // A refusal read as an empty list would latch `regionsLoaded` and the
      // error below for the life of the shell, since nothing re-fetches after
      // a successful-looking answer.
      if (exitCode !== 0) return

      var parsed = ExpressVpn.parseRegions(String(regionsStdout.text || ""))
      root.regions = parsed
      root.regionsLoaded = true
      if (parsed.length === 0) {
        root.lastError = "Could not read the location list. Check: expressvpnctl get regions"
      }
    }
  }

  Process {
    id: lockProcess
    running: false
    command: ["expressvpnctl", "get", "networklock"]
    stdout: StdioCollector { id: lockStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      var parsed = ExpressVpn.parseNetworkLock(String(lockStdout.text || ""))
      if (parsed.known) {
        root.networkLock = parsed
        root.reconcileToggles(parsed)
      }
    }
  }

  Process {
    id: commandProcess
    running: false
    command: []
    stdout: StdioCollector { id: commandStdout; waitForEnd: true }
    stderr: StdioCollector { id: commandStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root._working = false
      var output = String(commandStderr.text || "") + "\n" + String(commandStdout.text || "")
      var kind = root._currentKind
      root._currentKind = ""

      if (kind === "toggle") {
        if (exitCode !== 0) {
          root.lastError = ExpressVpn.describeExpressFailure(output, "ExpressVPN refused that setting")
          root.clearPending(root._toggleKey)
        }
        root._toggleKey = ""
        if (!lockProcess.running) lockProcess.running = true
        return
      }

      if (exitCode !== 0) {
        root._desired = -1
        root.lastError = ExpressVpn.describeExpressFailure(output, "ExpressVPN command failed")
      } else {
        root.lastError = ""
      }
      root.actionStatus = ""
      settleTimer.ticks = 0
      settleTimer.restart()
      root.refresh()
    }
  }

  // Which command is on the wire, so its exit is bookkept as what it was.
  property string _currentKind: ""

  function clearPending(key) {
    var pending = {}
    for (var name in _pendingToggles) {
      if (name !== key) pending[name] = _pendingToggles[name]
    }
    _pendingToggles = pending
    pendingTimer.stop()
  }
}
