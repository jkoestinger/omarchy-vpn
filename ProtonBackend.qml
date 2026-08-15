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
  readonly property string emptyText: countriesLoaded ? "No countries match." : "Loading countries…"
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
    if (_probed && force !== true) return
    detectProcess.running = true
  }

  function refresh() {
    if (!detected || statusProcess.running) return
    statusProcess.running = true
    if (!configProcess.running) configProcess.running = true
    if (!countriesLoaded && !countriesProcess.running) countriesProcess.running = true
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
    toggleProcess.command = ["protonvpn"].concat(args)
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
    connectProcess.command = ["protonvpn", "connect"].concat(target.args || [])
    connectProcess.running = true
  }

  function disconnect() {
    if (!detected || connectProcess.running) return
    _desired = 0
    lastError = ""
    actionStatus = "Disconnecting…"
    connectProcess.command = ["protonvpn", "disconnect"]
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
      root.refresh()
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
    command: ["protonvpn", "status"]
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.applyStatus(String(statusStdout.text || ""))
        root.lastError = ""
      } else {
        root.lastError = Shared.elide(String(statusStderr.text || statusStdout.text || "") || "Could not read Proton VPN status", 140)
      }
    }
  }

  Process {
    id: connectProcess
    running: false
    command: []
    stdout: StdioCollector { id: connectStdout; waitForEnd: true }
    stderr: StdioCollector { id: connectStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root._desired = -1
        root.lastError = Shared.elide(String(connectStderr.text || connectStdout.text || "") || "Proton VPN command failed", 140)
      } else {
        root.lastError = ""
      }
      root.actionStatus = ""
      settleTimer.ticks = 0
      settleTimer.restart()
      root.refresh()
    }
  }

  Process {
    id: configProcess
    running: false
    command: ["protonvpn", "config", "list"]
    stdout: StdioCollector { id: configStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      root.applyConfig(String(configStdout.text || ""))
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
      if (!configProcess.running) configProcess.running = true
    }
  }

  // "Loaded" means asked and answered. A table this parser cannot read is a
  // reason to say so once, not to re-fetch the list on every poll for as long
  // as the shell runs.
  Process {
    id: countriesProcess
    running: false
    command: ["protonvpn", "countries", "list"]
    stdout: StdioCollector { id: countriesStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      root.countries = Proton.parseProtonCountries(String(countriesStdout.text || ""))
      root.countriesLoaded = true
      if (root.countries.length === 0) {
        root.lastError = "Could not read the country list. Check: protonvpn countries list"
      }
    }
  }
}
