import QtQuick
import Quickshell.Io
import "model/Shared.js" as Shared
import "model/Mullvad.js" as Mullvad

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
  readonly property var installNames: ["Mullvad"]
  readonly property string glyph: Shared.GLYPH_VPN
  readonly property bool supportsFilter: true
  // Cities match too, but the field is only so wide.
  readonly property string filterPlaceholder: "Filter countries — press / to search"

  property bool detected: false
  property var status: Mullvad.parseMullvadStatus("")
  property var relays: []
  property bool relaysLoaded: false
  property var daemonSettings: Mullvad.parseMullvadSettings("")
  property string actionStatus: ""
  property string lastError: ""

  // The stored "block traffic while disconnected" setting, which the status
  // payload only reports while the tunnel is already down. False also covers
  // "the daemon never answered for it" — see parseMullvadSettings — so this
  // drives a warning and never a switch position.
  readonly property bool lockdownMode: daemonSettings.seen !== undefined
    && daemonSettings.seen.lockdown === true
    && daemonSettings.lockdown
  readonly property string lockdownHint: "mullvad lockdown-mode set off"

  // Switches the panel draws under the detail rows. Values are whatever the
  // daemon last reported; the widget stores none of them.
  readonly property var toggles: Shared.applyPendingToggles(Mullvad.mullvadToggles(daemonSettings), _pendingToggles)
  property var _pendingToggles: ({})

  // Optimistic connection state so the switch flips the instant you click it.
  // -1 follows the daemon, 0/1 while a connect/disconnect is still in flight.
  property int _desired: -1

  readonly property bool connected: _desired === -1 ? status.connected : (_desired === 1)
  // A connect spans two processes with an event-loop hop between them, so
  // "running" alone would leave a gap a second click could slip through.
  readonly property bool _working: commandProcess.running || chainTimer.running || _stage !== ""
  readonly property bool busy: _working || statusProcess.running
  readonly property string summary: Mullvad.mullvadSummary(status)
  readonly property var details: Mullvad.mullvadDetails(status)
  readonly property var favorites: Shared.favoriteCodes(setting("favoriteCountries", "CH,NL,US"))
  readonly property string emptyText: relaysLoaded ? "No countries match." : "Loading relays…"
  readonly property string currentKey: Mullvad.mullvadCurrentKey(status, relays)
  readonly property var targets: filter === ""
    ? Mullvad.mullvadQuickTargets().concat(Mullvad.mullvadCountryTargets(relays, favorites, ""))
    : Mullvad.mullvadCountryTargets(relays, favorites, filter)

  // What connectTo() is in the middle of: "location", then "connect".
  property string _stage: ""
  property var _pendingTarget: null
  // Which switch is in flight, so a refusal rolls back the right one.
  property string _toggleKey: ""

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // Asked once. `force` is the user asking again, which is the only time the
  // answer could have changed — see refreshAll() in VpnController.
  property bool _probed: false

  function detect(force) {
    if (detectProcess.running) return
    // Also the only thing that re-reads a relay list the CLI refused, since the
    // guard below latches on the answer and not on the answer being usable.
    if (force === true) relaysLoaded = false
    if (_probed && force !== true) return
    detectProcess.running = true
  }

  function refresh() {
    if (!detected || statusProcess.running) return
    statusProcess.running = true
    if (!settingsProcess.running) settingsProcess.running = true
    if (!relaysLoaded && !relaysProcess.running) relaysProcess.running = true
  }

  function setToggle(key, value) {
    if (!detected || toggleProcess.running) return

    var args = Mullvad.mullvadToggleArgs(key, value)
    if (args.length === 0) return

    var pending = {}
    for (var name in _pendingToggles) pending[name] = _pendingToggles[name]
    pending[key] = value
    _pendingToggles = pending

    lastError = ""
    _toggleKey = key
    toggleProcess.command = ["mullvad"].concat(args)
    toggleProcess.running = true
    pendingTimer.restart()
  }

  function applySettings(raw) {
    var parsed = Mullvad.parseMullvadSettings(raw)
    // A read that answered nothing is not a report that everything is off.
    // Keep whatever the daemon last actually said.
    if (!parsed.loaded) return
    root.daemonSettings = parsed

    // Drop the optimistic value only for the switches the daemon now agrees
    // with, so a poll landing mid-flight cannot flick the others back. A
    // setting the daemon did not answer for agrees with nothing.
    var pending = {}
    var changed = false
    for (var key in _pendingToggles) {
      if (parsed.seen[key] === true && parsed[key] === _pendingToggles[key]) changed = true
      else pending[key] = _pendingToggles[key]
    }
    if (changed) _pendingToggles = pending
  }

  function clearPending(key) {
    var pending = {}
    for (var name in _pendingToggles) {
      if (name !== key) pending[name] = _pendingToggles[name]
    }
    _pendingToggles = pending
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
    var parsed = Mullvad.parseMullvadStatus(raw)
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
    return Shared.elide(text || fallback, 140)
  }

  function daemonUnreachable(text) {
    return /daemon|rpc|transport error|connection refused/i.test(String(text || ""))
  }

  function daemonMessage() {
    return "The Mullvad daemon is not responding. Start it with: sudo systemctl start mullvad-daemon"
  }

  // A command that exits clean but does not take — the daemon accepts it and
  // then reports the old value — would otherwise leave the switch showing the
  // position the user asked for, marked busy, for as long as the panel is open.
  // Optimism gets a deadline.
  Timer {
    id: pendingTimer
    interval: 10000
    repeat: false
    onTriggered: {
      if (Object.keys(root._pendingToggles).length === 0) return
      root._pendingToggles = ({})
      root.lastError = "Mullvad did not apply that setting."
    }
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

  Process {
    id: detectProcess
    command: ["omarchy-cmd-present", "mullvad"]
    running: true
    onExited: function(exitCode) {
      root._probed = true
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
        : Shared.elide(output || "Could not read Mullvad status", 140)
    }
  }

  // Three subcommands, one process. Each answer names itself, so the parser
  // does not care about the order they come back in.
  //
  // The exit code belongs to the last subcommand alone and says nothing about
  // the other two, so it is not consulted: the parser reads whichever answers
  // arrived and reports the rest as unanswered rather than as off.
  Process {
    id: settingsProcess
    running: false
    command: ["bash", "-c", "mullvad auto-connect get; mullvad lockdown-mode get; mullvad lan get"]
    stdout: StdioCollector { id: settingsStdout; waitForEnd: true }
    onExited: function(exitCode) {
      root.applySettings(String(settingsStdout.text || ""))
    }
  }

  Process {
    id: toggleProcess
    running: false
    command: []
    stdout: StdioCollector { id: toggleStdout; waitForEnd: true }
    stderr: StdioCollector { id: toggleStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.lastError = root.describeFailure(
          String(toggleStderr.text || "") + "\n" + String(toggleStdout.text || ""),
          "Mullvad refused that setting")
        root.clearPending(root._toggleKey)
      }
      root._toggleKey = ""
      if (!settingsProcess.running) settingsProcess.running = true
    }
  }

  // `relay list` is the largest thing this CLI prints, so "loaded" has to mean
  // "asked and answered", not "answered with something". Keying it off the
  // parsed count made a format change re-fetch the whole list on every poll,
  // forever, while the panel showed no countries and no reason why.
  Process {
    id: relaysProcess
    running: false
    command: ["mullvad", "relay", "list"]
    stdout: StdioCollector { id: relaysStdout; waitForEnd: true }
    stderr: StdioCollector { id: relaysStderr; waitForEnd: true }
    onExited: function(exitCode) {
      // A refusal is an answer too. Returning here without latching left a
      // daemon that was down — or a CLI that wanted an account — re-asked for
      // the largest thing this tool prints on every poll, forever.
      var unreadable = "Could not read the relay list. Check: mullvad relay list"
      root.relaysLoaded = true
      if (exitCode !== 0) {
        root.lastError = root.describeFailure(
          String(relaysStderr.text || "") + "\n" + String(relaysStdout.text || ""), unreadable)
        return
      }
      root.relays = Mullvad.parseMullvadRelays(String(relaysStdout.text || ""))
      if (root.relays.length === 0) root.lastError = unreadable
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
