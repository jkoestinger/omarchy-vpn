import QtQuick
import Quickshell.Io
import "Model.js" as Model

// Mullvad backend, driven by the `mullvad` CLI talking to `mullvad-daemon`.
// Implements the backend contract documented in VpnController.qml.
//
// Mullvad splits "pick a relay" from "bring the tunnel up", so connecting is
// two commands rather than one — see connectTo().
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "mullvad"
  readonly property string label: "Mullvad"
  readonly property string glyph: Model.GLYPH_VPN
  readonly property bool supportsFilter: true
  // Cities match too, but the field is only so wide.
  readonly property string filterPlaceholder: "Filter countries — press / to search"

  property bool detected: false
  property var status: Model.parseMullvadStatus("")
  property var relays: []
  property bool relaysLoaded: false
  // The stored "block traffic while disconnected" setting, which the status
  // payload only reports while the tunnel is already down.
  property bool lockdownMode: false
  property string actionStatus: ""
  property string lastError: ""

  // Optimistic connection state so the switch flips the instant you click it.
  // -1 follows the daemon, 0/1 while a connect/disconnect is still in flight.
  property int _desired: -1

  readonly property bool connected: _desired === -1 ? status.connected : (_desired === 1)
  // A connect spans two processes with an event-loop hop between them, so
  // "running" alone would leave a gap a second click could slip through.
  readonly property bool _working: commandProcess.running || chainTimer.running || _stage !== ""
  readonly property bool busy: _working || statusProcess.running
  readonly property string summary: Model.mullvadSummary(status)
  readonly property var details: Model.mullvadDetails(status)
  readonly property var favorites: Model.favoriteCodes(setting("favoriteCountries", "CH,NL,US"))
  readonly property string emptyText: relaysLoaded ? "No countries match." : "Loading relays…"
  readonly property string currentKey: Model.mullvadCurrentKey(status, relays)
  readonly property var targets: filter === ""
    ? Model.mullvadQuickTargets().concat(Model.mullvadCountryTargets(relays, favorites, ""))
    : Model.mullvadCountryTargets(relays, favorites, filter)

  // What connectTo() is in the middle of: "location", then "connect".
  property string _stage: ""
  property var _pendingTarget: null

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function detect() {
    if (detectProcess.running) return
    detectProcess.running = true
  }

  function refresh() {
    if (!detected || statusProcess.running) return
    statusProcess.running = true
    if (!lockdownProcess.running) lockdownProcess.running = true
    if (!relaysLoaded && !relaysProcess.running) relaysProcess.running = true
  }

  // Two commands, not one. `relay set location` only records a constraint; the
  // tunnel comes up on the `connect` that follows. A failed constraint must
  // stop the chain — otherwise the connect succeeds against whatever relay was
  // selected before and the panel reports the wrong country as connected.
  function connectTo(target) {
    if (!detected || _working || !target) return

    _desired = 1
    _pendingTarget = target
    lastError = ""
    actionStatus = "Connecting to " + target.label + "…"
    runStage("location", ["relay", "set", "location"].concat(target.args || []))
  }

  function disconnect() {
    if (!detected || _working) return
    _desired = 0
    lastError = ""
    actionStatus = "Disconnecting…"
    runStage("disconnect", ["disconnect"])
  }

  // Mullvad has no notion of a fastest server: `connect` uses the relay
  // constraint already stored, which is whatever was picked last.
  function toggleConnection() {
    if (connected) {
      disconnect()
      return
    }
    if (!detected || _working) return

    _desired = 1
    _pendingTarget = null
    lastError = ""
    actionStatus = "Connecting…"
    runStage("connect", ["connect"])
  }

  function runStage(stage, args) {
    root._stage = stage
    commandProcess.command = ["mullvad"].concat(args)
    commandProcess.running = true
  }

  function applyStatus(raw) {
    var parsed = Model.parseMullvadStatus(raw)
    root.status = parsed
    // Reality caught up with the pending connect/disconnect — stop overriding.
    if (_desired !== -1 && parsed.connected === (_desired === 1)) _desired = -1
  }

  function describeFailure(output, fallback) {
    var text = String(output || "").trim()
    if (/log ?in|not logged in|no account/i.test(text)) {
      return "No Mullvad account on this machine. Log in with: mullvad account login"
    }
    if (daemonUnreachable(text)) return daemonMessage()
    return Model.elide(text || fallback, 140)
  }

  function daemonUnreachable(text) {
    return /daemon|rpc|transport error|connection refused/i.test(String(text || ""))
  }

  function daemonMessage() {
    return "The Mullvad daemon is not responding. Start it with: sudo systemctl start mullvad-daemon"
  }

  // The daemon reports the new state a beat after the command returns, and a
  // WireGuard handshake over a slow link can take a few seconds more than
  // Proton's CLI does, so poll a little longer than that backend.
  Timer {
    id: settleTimer
    property int ticks: 0
    interval: 1500
    repeat: true
    running: false
    onTriggered: {
      settleTimer.ticks += 1
      root.refresh()
      if (settleTimer.ticks >= 6) {
        settleTimer.ticks = 0
        settleTimer.running = false
        root._desired = -1
      }
    }
  }

  // Starting the next command from inside onExited would re-enter the process
  // that is still finishing, so the chain hops through the event loop first.
  Timer {
    id: chainTimer
    interval: 0
    repeat: false
    onTriggered: root.runStage("connect", ["connect"])
  }

  Timer {
    id: actionStatusTimer
    interval: 2600
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Process {
    id: detectProcess
    command: ["omarchy-cmd-present", "mullvad"]
    running: true
    onExited: function(exitCode) {
      root.detected = exitCode === 0
      if (root.detected) root.refresh()
    }
  }

  Process {
    id: statusProcess
    running: false
    command: ["mullvad", "status", "-j"]
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.applyStatus(String(statusStdout.text || ""))
        root.lastError = ""
        return
      }

      // Installed but unusable is its own state: keep the tool listed and say
      // what to do about it rather than quietly dropping off the switcher.
      var output = String(statusStderr.text || statusStdout.text || "")
      root.lastError = root.daemonUnreachable(output)
        ? root.daemonMessage()
        : Model.elide(output || "Could not read Mullvad status", 140)
    }
  }

  Process {
    id: lockdownProcess
    running: false
    command: ["mullvad", "lockdown-mode", "get"]
    stdout: StdioCollector { id: lockdownStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      root.lockdownMode = Model.mullvadLockdownEnabled(String(lockdownStdout.text || ""))
    }
  }

  Process {
    id: relaysProcess
    running: false
    command: ["mullvad", "relay", "list"]
    stdout: StdioCollector { id: relaysStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      root.relays = Model.parseMullvadRelays(String(relaysStdout.text || ""))
      root.relaysLoaded = root.relays.length > 0
    }
  }

  Process {
    id: commandProcess
    running: false
    command: []
    stdout: StdioCollector { id: commandStdout; waitForEnd: true }
    stderr: StdioCollector { id: commandStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var output = String(commandStderr.text || "") + "\n" + String(commandStdout.text || "")

      if (root._stage === "location") {
        if (exitCode !== 0) {
          var name = root._pendingTarget ? root._pendingTarget.label : "that location"
          root._desired = -1
          root._pendingTarget = null
          root._stage = ""
          root.actionStatus = ""
          root.lastError = root.describeFailure(output, "Mullvad rejected " + name)
          return
        }
        root._stage = ""
        chainTimer.restart()
        return
      }

      if (exitCode !== 0) {
        root._desired = -1
        root.lastError = root.describeFailure(output, "Mullvad command failed")
      } else {
        root.lastError = ""
      }

      root._stage = ""
      root._pendingTarget = null
      root.actionStatus = ""
      settleTimer.ticks = 0
      settleTimer.restart()
      root.refresh()
    }
  }
}
