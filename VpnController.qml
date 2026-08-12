import QtQuick
import Quickshell.Io
import "Model.js" as Model

// Owns every VPN backend, decides which one the panel is looking at, and polls
// the detected ones. The panel talks to `active` and never to a specific tool.
//
// Backend contract (duck-typed — a backend is any Item exposing these):
//
//   backendId, label, glyph          identity for the switcher chips
//   supportsFilter, filterPlaceholder whether the panel shows its filter field
//   filter                           panel writes the current filter text here
//   detected                         tool is installed and has something to offer
//   setupHint                        optional: what to do about being undetected
//   connected, summary               headline state
//   details                          [{ label, value }] shown while connected
//   targets                          [{ key, label, detail, glyph, args }]
//   emptyText                        shown when targets is empty
//   toggles                          [{ key, label, detail, value, busy }] tool settings
//   busy, actionStatus, lastError    transient feedback
//   detect(), refresh()              probing
//   connectTo(target), disconnect(), toggleConnection()
//   setToggle(key, value)            flip one of the tool's own settings
Item {
  id: root
  visible: false

  property var settings: ({})

  // Set when the user picks a chip; "" follows `preferredBackend`.
  property string selectedId: ""

  readonly property var backends: [proton, mullvad, networkManager]
  // Tools this machine has. Hiding one is a statement about the widget, not
  // about the machine, so the settings view lists these — including the hidden
  // ones, which would otherwise be unreachable once they were switched off.
  readonly property var detectedBackends: backends.filter(function(backend) { return backend.detected })
  readonly property var hiddenBackendIds: Model.parseBackendIds(setting("hiddenBackends", ""))
  readonly property var availableBackends: detectedBackends.filter(function(backend) {
    return !root.isHidden(backend.backendId)
  })
  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 15, 5, 600)

  function isHidden(backendId) {
    return hiddenBackendIds.indexOf(String(backendId)) !== -1
  }

  readonly property var active: {
    var available = availableBackends
    if (available.length === 0) return null

    for (var i = 0; i < available.length; i++) {
      if (available[i].backendId === selectedId) return available[i]
    }

    var preferred = preferredId()
    if (preferred !== "") {
      for (var j = 0; j < available.length; j++) {
        if (available[j].backendId === preferred) return available[j]
      }
    }

    // Auto: whichever tool is actually carrying traffic wins, so the panel
    // opens on the connection you are using rather than on a list order.
    for (var k = 0; k < available.length; k++) {
      if (available[k].connected) return available[k]
    }
    return available[0]
  }

  readonly property bool anyConnected: availableBackends.some(function(backend) { return backend.connected })
  readonly property bool anyDetected: availableBackends.length > 0

  readonly property var connectedBackend: {
    var available = availableBackends
    for (var i = 0; i < available.length; i++) {
      if (available[i].connected) return available[i]
    }
    return null
  }

  readonly property string barSummary: {
    if (!anyDetected) {
      return detectedBackends.length > 0 ? "Every VPN tool is hidden" : "No VPN tool installed"
    }
    var backend = connectedBackend
    if (!backend) return "Not connected"
    return backend.label + " · " + backend.summary
  }

  readonly property var switcherOptions: availableBackends.map(function(backend) {
    return { value: backend.backendId, label: backend.label }
  })

  // An installed tool with nothing to show hides itself, so the panel would
  // otherwise tell you to install what you already have. Optional: a backend
  // without the property simply has nothing to say.
  readonly property string setupHint: {
    for (var i = 0; i < backends.length; i++) {
      if (isHidden(backends[i].backendId)) continue
      var hint = backends[i].setupHint
      if (hint !== undefined && String(hint) !== "") return String(hint)
    }
    return ""
  }

  // ------------------------------------------------------------- public IP

  property string publicIp: ""
  property bool ipFetching: false
  property bool ipFailed: false

  // Identifies the tunnel currently carrying traffic. Any change to it — a
  // connect, a disconnect, a server switch — means the exit address changed,
  // which is the only thing that should cost a network round trip. No polling.
  readonly property string connectionKey: {
    var backend = connectedBackend
    return backend ? backend.backendId + "|" + backend.summary : "direct"
  }

  onConnectionKeyChanged: ipSettle.restart()

  // A shell restart inherits whatever tunnel was already up, so no change ever
  // fires. One request at startup gives the bar tooltip something to say.
  Component.onCompleted: ipSettle.restart()

  function refreshPublicIp() {
    if (ipProcess.running) return
    ipFetching = true
    ipFailed = false
    ipProcess.running = true
  }

  // Routes take a moment to settle after the tunnel reports up; asking too
  // early returns the old address.
  Timer {
    id: ipSettle
    interval: 2000
    repeat: false
    onTriggered: root.refreshPublicIp()
  }

  Process {
    id: ipProcess
    running: false
    command: ["curl", "--silent", "--max-time", "6", "checkip.amazonaws.com"]
    stdout: StdioCollector { id: ipStdout; waitForEnd: true }
    onExited: function(exitCode) {
      root.ipFetching = false
      var address = String(ipStdout.text || "").trim()
      if (exitCode === 0 && address !== "") {
        root.publicIp = address
        root.ipFailed = false
      } else {
        root.ipFailed = true
      }
    }
  }

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    if (n < min) n = min
    if (n > max) n = max
    return n
  }

  function preferredId() {
    var preferred = String(setting("preferredBackend", "Auto"))
    if (preferred === "Proton VPN") return "proton"
    if (preferred === "Mullvad") return "mullvad"
    if (preferred === "NetworkManager") return "networkmanager"
    return ""
  }

  function selectBackend(backendId) {
    root.selectedId = String(backendId || "")
    var backend = root.active
    if (backend) backend.refresh()
  }

  // Two tunnels up at once is never what anyone means by "connect". Bringing
  // one up therefore takes every other backend down first, and the new
  // connection waits for them so the tools do not fight over the routes.
  function connectVia(backend, target) {
    runExclusive(backend, function() { backend.connectTo(target) })
  }

  function toggleActive() {
    var backend = root.active
    if (!backend) return
    if (backend.connected) {
      backend.disconnect()
      return
    }
    runExclusive(backend, function() { backend.toggleConnection() })
  }

  function runExclusive(backend, action) {
    var others = otherConnected(backend)
    if (others.length === 0) {
      action()
      return
    }

    for (var i = 0; i < others.length; i++) {
      // Mullvad's lockdown mode drops all traffic the moment its tunnel goes
      // down, which is exactly when the incoming connect needs the network.
      // Say so up front rather than let it fail as a timeout.
      if (others[i].lockdownMode === true) {
        backend.lastError = others[i].label + " blocks all traffic while it is disconnected, "
          + "so connecting will not get through. Turn it off with: mullvad lockdown-mode set off"
      }
      others[i].disconnect()
    }
    root._pendingAction = action
    root._pendingBackend = backend
    exclusiveWait.ticks = 0
    exclusiveWait.restart()
  }

  function otherConnected(backend) {
    return availableBackends.filter(function(candidate) {
      return candidate !== backend && candidate.connected
    })
  }

  property var _pendingAction: null
  property var _pendingBackend: null

  // The backends report their new state through their own polling, so wait for
  // them to actually report down rather than assuming the disconnect landed.
  // Giving up after ~10s still runs the action: a stuck teardown should not
  // silently swallow the connect the user asked for.
  Timer {
    id: exclusiveWait
    property int ticks: 0
    interval: 700
    repeat: true
    running: false
    onTriggered: {
      ticks += 1
      var action = root._pendingAction
      if (!action) { exclusiveWait.running = false; return }

      if (root.otherConnected(root._pendingBackend).length === 0 || ticks >= 15) {
        exclusiveWait.running = false
        root._pendingAction = null
        root._pendingBackend = null
        action()
      }
    }
  }

  // A hidden tool is still probed — the settings view has to list it for you to
  // switch it back on — but never polled: not asking is the point of hiding it.
  function refreshAll() {
    for (var i = 0; i < backends.length; i++) {
      if (!backends[i].detected) backends[i].detect()
      else if (!isHidden(backends[i].backendId)) backends[i].refresh()
    }
  }

  ProtonBackend {
    id: proton
    settings: root.settings
  }

  MullvadBackend {
    id: mullvad
    settings: root.settings
  }

  NetworkManagerBackend {
    id: networkManager
    settings: root.settings
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refreshAll()
  }
}
