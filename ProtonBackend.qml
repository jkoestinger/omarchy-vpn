import QtQuick
import Quickshell.Io
import "Model.js" as Model

// Proton VPN backend, driven by the `protonvpn` CLI. Implements the backend
// contract documented in VpnController.qml.
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "proton"
  readonly property string label: "Proton VPN"
  readonly property string glyph: Model.GLYPH_VPN
  readonly property bool supportsFilter: true
  readonly property string filterPlaceholder: "Filter countries — press / to search"

  property bool detected: false
  property var status: Model.parseProtonStatus("")
  property var countries: []
  property bool countriesLoaded: false
  property string actionStatus: ""
  property string lastError: ""

  // Optimistic connection state so the switch flips the instant you click it.
  // -1 follows the CLI, 0/1 while a connect/disconnect is still in flight.
  property int _desired: -1

  readonly property bool connected: _desired === -1 ? status.connected : (_desired === 1)
  readonly property bool busy: connectProcess.running || statusProcess.running
  readonly property string summary: Model.protonSummary(status)
  readonly property var details: Model.protonDetails(status)
  readonly property var favorites: Model.favoriteCodes(setting("favoriteCountries", "CH,NL,US"))
  readonly property string emptyText: countriesLoaded ? "No countries match." : "Loading countries…"
  // Server names carry their country: "NL#42" is the Netherlands row.
  readonly property string currentKey: {
    if (!connected) return ""
    var match = String(status.server || "").match(/^([A-Za-z]{2})#/)
    return match ? "country:" + match[1].toUpperCase() : ""
  }
  readonly property var targets: filter === ""
    ? Model.protonQuickTargets().concat(Model.protonCountryTargets(countries, favorites, ""))
    : Model.protonCountryTargets(countries, favorites, filter)

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
    if (!countriesLoaded && !countriesProcess.running) countriesProcess.running = true
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
    var parsed = Model.parseProtonStatus(raw)
    root.status = parsed
    // Reality caught up with the pending connect/disconnect — stop overriding.
    if (_desired !== -1 && parsed.connected === (_desired === 1)) _desired = -1
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
        root.lastError = Model.elide(String(statusStderr.text || statusStdout.text || "") || "Could not read Proton VPN status", 140)
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
        root.lastError = Model.elide(String(connectStderr.text || connectStdout.text || "") || "Proton VPN command failed", 140)
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
    id: countriesProcess
    running: false
    command: ["protonvpn", "countries", "list"]
    stdout: StdioCollector { id: countriesStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      root.countries = Model.parseProtonCountries(String(countriesStdout.text || ""))
      root.countriesLoaded = true
    }
  }
}
