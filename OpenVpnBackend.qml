import QtQuick
import Quickshell.Io
import "Model.js" as Model

// OpenVPN backend. OpenVPN itself has no session daemon to ask, so the profiles
// come from NetworkManager, which is what imports and stores .ovpn files on a
// desktop. Implements the backend contract documented in VpnController.qml.
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "openvpn"
  readonly property string label: "OpenVPN"
  readonly property string glyph: Model.GLYPH_VPN
  readonly property bool supportsFilter: false
  readonly property string filterPlaceholder: ""

  property bool detected: false
  property var profiles: []
  property string actionStatus: ""
  property string lastError: ""

  property bool _nmcliPresent: false
  property bool _openvpnPresent: false
  property int _desired: -1
  property var _pendingTarget: null

  // NetworkManager refuses to activate a profile whose secrets it does not
  // hold, and the Omarchy shell runs no NM secret agent to prompt with. The
  // panel answers this by re-running the activation in a terminal, where
  // `nmcli --ask` can collect the credentials itself.
  signal authRequired(string command)

  readonly property bool _activeNow: Model.activeOpenVpnProfile(profiles) !== null
  readonly property bool connected: _desired === -1 ? _activeNow : (_desired === 1)
  readonly property bool busy: connectProcess.running || listProcess.running || typesProcess.running
  readonly property string summary: Model.openVpnSummary(profiles)
  readonly property var details: Model.openVpnDetails(profiles)
  readonly property var targets: Model.openVpnTargets(profiles)
  readonly property string emptyText: "No OpenVPN profiles yet. Import one with: nmcli connection import type openvpn file <config.ovpn>"
  readonly property string currentKey: {
    var profile = Model.activeOpenVpnProfile(profiles)
    return profile ? "profile:" + profile.uuid : ""
  }

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function detect() {
    if (nmcliProbe.running || openvpnProbe.running) return
    nmcliProbe.running = true
    openvpnProbe.running = true
  }

  function _updateDetected() {
    root.detected = _nmcliPresent && _openvpnPresent
    if (root.detected) root.refresh()
  }

  function refresh() {
    if (!detected || listProcess.running) return
    listProcess.running = true
  }

  function connectTo(target) {
    if (!detected || connectProcess.running || !target) return

    // `nmcli --ask` prompts for secrets only, and the OpenVPN username is not
    // one — it lives in vpn.data. Without it the profile authenticates as the
    // empty user and the server rejects it, so point at the fix rather than
    // open a password prompt that cannot succeed.
    if (target.hasUsername === false) {
      lastError = "\"" + target.label + "\" has no username. Set one with: nmcli connection modify "
        + target.label + " +vpn.data username=<user>"
      return
    }

    _desired = 1
    _pendingTarget = target
    lastError = ""
    actionStatus = "Connecting to " + target.label + "…"
    connectProcess.command = ["nmcli"].concat(target.args || [])
    connectProcess.running = true
  }

  function missingSecrets(text) {
    return /no valid secrets|secrets were required|vpn\.secrets/i.test(String(text || ""))
  }

  function disconnect() {
    if (!detected || connectProcess.running) return

    var active = Model.activeOpenVpnProfile(profiles)
    if (!active) return

    _desired = 0
    lastError = ""
    actionStatus = "Disconnecting…"
    connectProcess.command = ["nmcli", "connection", "down", "uuid", active.uuid]
    connectProcess.running = true
  }

  function toggleConnection() {
    if (connected) {
      disconnect()
      return
    }
    // One profile is an unambiguous "the VPN"; several need a pick.
    if (profiles.length === 1) connectTo(targets[0])
    else if (profiles.length === 0) actionStatus = "Import an OpenVPN profile first"
    else actionStatus = "Pick a profile below"
    actionStatusTimer.restart()
  }

  function applyProfiles(list) {
    root.profiles = list
    if (_desired !== -1 && (Model.activeOpenVpnProfile(list) !== null) === (_desired === 1)) _desired = -1
  }

  Timer {
    id: actionStatusTimer
    interval: 2600
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  // NetworkManager reports the new state a beat after nmcli returns.
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
    id: nmcliProbe
    command: ["omarchy-cmd-present", "nmcli"]
    running: true
    onExited: function(exitCode) {
      root._nmcliPresent = exitCode === 0
      root._updateDetected()
    }
  }

  Process {
    id: openvpnProbe
    command: ["omarchy-cmd-present", "openvpn"]
    running: true
    onExited: function(exitCode) {
      root._openvpnPresent = exitCode === 0
      root._updateDetected()
    }
  }

  // Every VPN-typed connection, whichever plugin backs it.
  Process {
    id: listProcess
    running: false
    command: ["nmcli", "-t", "-f", "NAME,UUID,TYPE,ACTIVE", "connection", "show"]
    stdout: StdioCollector { id: listStdout; waitForEnd: true }
    stderr: StdioCollector { id: listStderr; waitForEnd: true }
    property var pending: []
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.lastError = Model.elide(String(listStderr.text || "") || "Could not list NetworkManager connections", 140)
        return
      }

      root.lastError = ""
      listProcess.pending = Model.parseNmcliConnections(String(listStdout.text || ""))
      if (listProcess.pending.length === 0) {
        root.applyProfiles([])
        return
      }

      // Second pass: only the OpenVPN ones survive, and the service type and
      // username are per-connection detail the summary listing does not carry.
      var command = ["nmcli", "-t", "-f", "connection.uuid,vpn.service-type,vpn.data", "connection", "show"]
      for (var i = 0; i < listProcess.pending.length; i++) command.push(listProcess.pending[i].uuid)
      typesProcess.command = command
      typesProcess.running = true
    }
  }

  Process {
    id: typesProcess
    running: false
    command: []
    stdout: StdioCollector { id: typesStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.applyProfiles([])
        return
      }

      var details = Model.parseNmcliVpnDetails(String(typesStdout.text || ""))
      var openVpnProfiles = []
      for (var i = 0; i < listProcess.pending.length; i++) {
        var candidate = listProcess.pending[i]
        var detail = details[candidate.uuid]
        if (!detail || !Model.isOpenVpnService(detail.serviceType)) continue

        candidate.hasUsername = detail.hasUsername
        openVpnProfiles.push(candidate)
      }
      root.applyProfiles(openVpnProfiles)
    }
  }

  Process {
    id: connectProcess
    running: false
    command: []
    stdout: StdioCollector { id: connectStdout; waitForEnd: true }
    stderr: StdioCollector { id: connectStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var output = String(connectStderr.text || "") + "\n" + String(connectStdout.text || "")
      if (exitCode !== 0) {
        root._desired = -1
        var target = root._pendingTarget
        if (root.missingSecrets(output) && target && target.uuid) {
          root.lastError = "This profile needs credentials — opening a terminal to enter them."
          root.authRequired("nmcli --ask connection up uuid " + target.uuid)
        } else {
          root.lastError = Model.elide(output.trim() || "nmcli command failed", 140)
        }
      } else {
        root.lastError = ""
      }
      root._pendingTarget = null
      root.actionStatus = ""
      settleTimer.ticks = 0
      settleTimer.restart()
      root.refresh()
    }
  }
}
