import QtQuick
import Quickshell.Io
import "model/Shared.js" as Shared
import "model/Proton.js" as Proton

// Proton VPN backend, driven by the `protonvpn` CLI. Implements the backend
// contract documented in VpnController.qml.
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "proton"
  readonly property string label: "Proton VPN"
  // What a user would go and install to make this backend useful, which is not
  // always the label: nobody installs "NetworkManager" to get a VPN.
  readonly property var installNames: ["Proton VPN"]
  readonly property string glyph: Shared.GLYPH_VPN
  readonly property bool supportsFilter: true
  readonly property string filterPlaceholder: "Filter countries — press / to search"

  property bool detected: false
  property var status: Proton.parseProtonStatus("")
  property var countries: []
  property bool countriesLoaded: false
  property var config: Proton.parseProtonConfig("")
  // Same meaning as countriesLoaded: asked and answered, not answered well.
  property bool _configLoaded: false
  // Set the first time a subcommand is refused for want of an account, and the
  // reason this backend stops asking. See noteAuth().
  property bool signedOut: false
  property string actionStatus: ""
  property string lastError: ""

  // Switches the panel draws under the detail rows. Values come from
  // `protonvpn config list`; the widget stores none of them.
  readonly property var toggles: Shared.applyPendingToggles(Proton.protonToggles(config), _pendingToggles)
  property var _pendingToggles: ({})
  // Which switch is in flight, so a refusal rolls back the right one.
  property string _toggleKey: ""
  // Last non-off value seen for the settings that have modes rather than an
  // on position: { "netshield": "malware-only", … }
  property var _lastModes: ({})

  // Optimistic connection state so the switch flips the instant you click it.
  // -1 follows the CLI, 0/1 while a connect/disconnect is still in flight.
  property int _desired: -1

  readonly property bool connected: _desired === -1 ? status.connected : (_desired === 1)
  readonly property bool busy: connectProcess.running || statusProcess.running
  readonly property string summary: Proton.protonSummary(status)
  readonly property var details: Proton.protonDetails(status)
  readonly property var favorites: Shared.favoriteCodes(setting("favoriteCountries", "CH,NL,US"))
  readonly property string emptyText: signedOut
    ? Proton.PROTON_SIGNIN_HINT
    : (countriesLoaded ? "No countries match." : "Loading countries…")
  // Server names carry their country: "NL#42" is the Netherlands row.
  readonly property string currentKey: {
    if (!connected) return ""
    var match = String(status.server || "").match(/^([A-Za-z]{2})#/)
    return match ? "country:" + match[1].toUpperCase() : ""
  }
  readonly property var targets: filter === ""
    ? Proton.protonQuickTargets().concat(Proton.protonCountryTargets(countries, favorites, ""))
    : Proton.protonCountryTargets(countries, favorites, filter)

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // Asked once. `force` is the user asking again, which is the only time the
  // answer could have changed — see refreshAll() in VpnController.
  property bool _probed: false

  function detect(force) {
    if (detectProcess.running) return
    // `force` is the user asking again — opening the panel, pressing r — which
    // is the one moment the answers below could have changed in a way they can
    // see: they signed in at a terminal, or changed a setting from the CLI.
    // Nothing else re-asks, because every one of these costs a Python start.
    if (force === true) {
      root._statusDue = true
      root.signedOut = false
      root.countriesLoaded = false
      root._configLoaded = false
    }
    if (_probed && force !== true) return
    detectProcess.running = true
  }

  // Ticks of the controller's interval between status reads.
  //
  // Connected is every one. A tunnel that drops while the panel is closed leaves
  // the chip claiming protection nobody has, and overstating protection is the
  // one wrong answer here worth a Python start to avoid.
  //
  // Disconnected is every fourth. Understating it is harmless by comparison, and
  // the only thing that turns disconnected into connected is somebody acting:
  // through this widget, which re-reads on its own through settleTimer, or at a
  // terminal, which the next slow tick catches within a minute.
  //
  // Signed out is never. The CLI cannot connect until somebody signs in, and
  // that is a forced refresh — opening the panel — away.
  readonly property int _statusEvery: signedOut ? 0 : (connected ? 1 : 4)
  property int _sinceStatus: 0
  // Ask on the next refresh whatever the cadence says. True at startup because
  // the first thing a probe wants is an answer.
  property bool _statusDue: true

  // Anything this backend runs, including the user's connects and toggles.
  // Every one of them queues behind the same lock, so the useful question is
  // never "is this process free" but "is this instance already holding a slot".
  readonly property bool _cliBusy: statusProcess.running || configProcess.running
    || countriesProcess.running || connectProcess.running || toggleProcess.running

  // Every non-hidden backend is polled on the interval whether or not the panel
  // is open, and `protonvpn` is Python: each invocation costs the best part of a
  // CPU-second before it does any work. So the poll asks for the status alone
  // once the other two have been answered, and asks for that on the cadence
  // above rather than on every tick.
  function refresh() {
    if (!detected) return

    _sinceStatus += 1
    if (_statusEvery > 0 && _sinceStatus >= _statusEvery) _statusDue = true

    _pump()
  }

  // Starts the one read the poll owes next, if this instance has nothing out.
  // Every read ends by asking again, so the tick's work drains as a chain; the
  // controller's next refresh() is only what restarts a chain that ended.
  function _pump() {
    if (!detected) return

    var next = Proton.protonNextRead({
      busy: _cliBusy,
      statusDue: _statusDue,
      signedOut: signedOut,
      configLoaded: _configLoaded,
      countriesLoaded: countriesLoaded
    })

    if (next === "status") {
      _statusDue = false
      _sinceStatus = 0
      statusProcess.running = true
    } else if (next === "config") {
      configProcess.running = true
    } else if (next === "countries") {
      countriesProcess.running = true
    }
  }

  // For the paths that have just changed something and need to see it land. The
  // cadence is for the idle case; a settling action is not one.
  function refreshNow() {
    _statusDue = true
    pumpTimer.restart()
  }

  // Latches the signed-out state from a refusal, and answers "was that a
  // refusal" so callers can skip their success path. The CLI keeps refusing for
  // as long as nobody signs in, and `protonvpn status` exits 0 throughout, so
  // nothing else in the poll would ever notice.
  function noteAuth(exitCode, out, err) {
    if (exitCode === 0) {
      root.signedOut = false
      return false
    }
    if (!Proton.protonAuthRequired(String(err || "") + "\n" + String(out || ""))) return false
    root.signedOut = true
    root.lastError = Proton.PROTON_SIGNIN_HINT
    return true
  }

  function setToggle(key, value) {
    if (!detected || toggleProcess.running) return

    var args = Proton.protonToggleArgs(key, value, _lastModes[key])
    if (args.length === 0) return

    var pending = {}
    for (var name in _pendingToggles) pending[name] = _pendingToggles[name]
    pending[key] = value
    _pendingToggles = pending

    lastError = ""
    _toggleKey = key
    toggleProcess.command = Proton.protonCli(args)
    toggleProcess.running = true
    pendingTimer.restart()
  }

  function applyConfig(raw) {
    var parsed = Proton.parseProtonConfig(raw)
    root.config = parsed
    // Remember the mode behind each on/off switch, so turning one back on
    // restores what was there instead of the default.
    root._lastModes = Proton.protonModes(parsed, root._lastModes)

    // "on" is not one value here — kill switch and NetShield each have modes —
    // so agreement is checked against the switch positions, not the raw text.
    var current = Proton.protonToggles(parsed)
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

  function clearPending(key) {
    var pending = {}
    for (var name in _pendingToggles) {
      if (name !== key) pending[name] = _pendingToggles[name]
    }
    _pendingToggles = pending
  }

  function connectTo(target) {
    if (!detected || connectProcess.running || !target) return
    _desired = 1
    lastError = ""
    actionStatus = "Connecting to " + target.label + "…"
    connectProcess.command = Proton.protonCli(["connect"].concat(target.args || []))
    connectProcess.running = true
  }

  function disconnect() {
    if (!detected || connectProcess.running) return
    _desired = 0
    lastError = ""
    actionStatus = "Disconnecting…"
    connectProcess.command = Proton.protonCli(["disconnect"])
    connectProcess.running = true
  }

  function toggleConnection() {
    if (connected) disconnect()
    else connectTo({ label: "the fastest server", args: [] })
  }

  function applyStatus(raw) {
    var parsed = Proton.parseProtonStatus(raw)
    root.status = parsed
    // Reality caught up with the pending connect/disconnect — stop overriding.
    if (_desired !== -1 && parsed.connected === (_desired === 1)) _desired = -1
  }

  // A command that exits clean but does not take — the CLI accepts it and then
  // lists the old value — would otherwise leave the switch showing the position
  // the user asked for, marked busy, for as long as the panel is open. Optimism
  // gets a deadline.
  Timer {
    id: pendingTimer
    interval: 10000
    repeat: false
    onTriggered: {
      if (Object.keys(root._pendingToggles).length === 0) return
      root._pendingToggles = ({})
      root.lastError = "Proton VPN did not apply that setting."
    }
  }

  // Nothing may start a `protonvpn` from inside another one's onExited: that
  // process is still running as far as `running` is concerned, so _pump would
  // read the instance as busy and drop the rest of the chain until the next
  // tick. One turn of the event loop later it has settled, and two exits
  // landing together collapse into one decision rather than two.
  Timer {
    id: pumpTimer
    interval: 0
    repeat: false
    onTriggered: root._pump()
  }

  // The CLI reports the new state a beat after the command returns, so re-poll
  // a few times instead of waiting out the controller's refresh interval.
  Timer {
    id: settleTimer
    property int ticks: 0
    interval: 1500
    repeat: true
    running: false
    onTriggered: {
      settleTimer.ticks += 1
      root.refreshNow()
      if (settleTimer.ticks >= 4) {
        settleTimer.ticks = 0
        settleTimer.running = false
        root._desired = -1
      }
    }
  }

  Process {
    id: detectProcess
    command: ["omarchy-cmd-present", "protonvpn"]
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
    command: Proton.protonCli(["status"])
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.applyStatus(String(statusStdout.text || ""))
        // Status succeeds while signed out, so clearing unconditionally would
        // wipe the one line telling the user why the panel is empty.
        root.lastError = root.signedOut ? Proton.PROTON_SIGNIN_HINT : ""
      } else {
        root.lastError = Shared.elide(String(statusStderr.text || statusStdout.text || "") || "Could not read Proton VPN status", 140)
      }
      pumpTimer.restart()
    }
  }

  Process {
    id: connectProcess
    running: false
    command: []
    stdout: StdioCollector { id: connectStdout; waitForEnd: true }
    stderr: StdioCollector { id: connectStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var connectOut = String(connectStdout.text || "")
      var connectErr = String(connectStderr.text || "")
      var refused = root.noteAuth(exitCode, connectOut, connectErr)
      if (exitCode !== 0) {
        root._desired = -1
        if (!refused) {
          root.lastError = Shared.elide(connectErr || connectOut || "Proton VPN command failed", 140)
        }
      } else {
        root.lastError = ""
      }
      root.actionStatus = ""
      settleTimer.ticks = 0
      settleTimer.restart()
      root.refreshNow()
    }
  }

  Process {
    id: configProcess
    running: false
    command: Proton.protonCli(["config", "list"])
    stdout: StdioCollector { id: configStdout; waitForEnd: true }
    stderr: StdioCollector { id: configStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var out = String(configStdout.text || "")
      var refusedConfig = root.noteAuth(exitCode, out, String(configStderr.text || ""))
      // Answered either way: a table this parser cannot read is a reason to show
      // no switches, not to re-read it on every poll for the life of the shell.
      if (!refusedConfig) root._configLoaded = true
      if (exitCode === 0) root.applyConfig(out)
      pumpTimer.restart()
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
        root.lastError = Shared.elide(
          String(toggleStderr.text || toggleStdout.text || "") || "Proton VPN refused that setting", 140)
        root.clearPending(root._toggleKey)
      }
      root._toggleKey = ""
      // Re-read the switches: the tool's answer is the only one this backend
      // shows. Through the chain, so it queues rather than racing the poll.
      root._configLoaded = false
      pumpTimer.restart()
    }
  }

  // "Loaded" means asked and answered. A table this parser cannot read is a
  // reason to say so once, not to re-fetch the list on every poll for as long
  // as the shell runs.
  Process {
    id: countriesProcess
    running: false
    command: Proton.protonCli(["countries", "list"])
    stdout: StdioCollector { id: countriesStdout; waitForEnd: true }
    stderr: StdioCollector { id: countriesStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var out = String(countriesStdout.text || "")
      var err = String(countriesStderr.text || "")
      if (root.noteAuth(exitCode, out, err)) {
        pumpTimer.restart()
        return
      }

      var unreadable = "Could not read the country list. Check: protonvpn countries list"
      root.countriesLoaded = true
      if (exitCode !== 0) {
        root.lastError = Shared.elide(err || out || unreadable, 140)
      } else {
        root.countries = Proton.parseProtonCountries(out)
        if (root.countries.length === 0) root.lastError = unreadable
      }
      pumpTimer.restart()
    }
  }
}
