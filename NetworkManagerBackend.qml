import QtQuick
import Quickshell.Io
import "model/Shared.js" as Shared
import "model/NetworkManager.js" as NetworkManager

// NetworkManager backend: every tunnel NetworkManager owns, which on a desktop
// means OpenVPN, WireGuard and OpenConnect. None has a session daemon of its
// own to ask — NetworkManager is what imports and stores `.ovpn` files,
// WireGuard configs and AnyConnect profiles alike. Implements the backend
// contract documented in VpnController.qml.
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "networkmanager"
  readonly property string label: "NetworkManager"
  // Three names, because this backend is the only way to reach any of the
  // protocols and the label names the manager rather than anything you would
  // install.
  readonly property var installNames: ["OpenVPN", "WireGuard", "OpenConnect"]

  // The helper that authenticates an OpenConnect profile. Resolved here
  // because only the backend knows where the plugin is installed.
  readonly property string openconnectAuth:
    Qt.resolvedUrl("bin/omarchy-openconnect-auth").toString().replace(/^file:\/\//, "")
  readonly property string glyph: Shared.GLYPH_VPN
  readonly property bool supportsFilter: false
  readonly property string filterPlaceholder: ""

  property var profiles: []
  property string actionStatus: ""
  property string lastError: ""

  property bool _nmcliPresent: false
  // One tunnel tool is enough: a machine with only WireGuard installed still
  // gets the chip, and a profile of a kind you cannot run simply never appears.
  property bool _openvpnPresent: false
  property bool _wireguardPresent: false
  property bool _openconnectPresent: false
  property int _probesDone: 0
  property bool _probed: false

  readonly property bool _toolsPresent:
    _nmcliPresent && (_openvpnPresent || _wireguardPresent || _openconnectPresent)
  // Having the tools is not having anything to connect to. NetworkManager is
  // the one backend whose list can be legitimately empty on a working install,
  // and a chip leading to an empty list is a chip worth not drawing.
  readonly property bool detected: _toolsPresent && profiles.length > 0

  // Said instead of the panel's "install a VPN tool" line, which is unhelpful
  // advice for someone who has the tools and only lacks a profile.
  readonly property string setupHint: _toolsPresent && profiles.length === 0 ? emptyText : ""
  property int _desired: -1
  property var _pendingTarget: null
  // Connecting can take two commands — down the profile that is up, then up the
  // one that was asked for. "" when nothing is in flight.
  property string _stage: ""

  // NetworkManager refuses to activate a profile whose secrets it does not
  // hold, and the Omarchy shell runs no NM secret agent to prompt with. The
  // panel answers this by re-running the activation in a terminal, where
  // `nmcli --ask` can collect the credentials itself.
  signal authRequired(string command)

  readonly property bool _activeNow: NetworkManager.activeNmProfile(profiles) !== null
  readonly property bool connected: _desired === -1 ? _activeNow : (_desired === 1)
  readonly property bool _working: connectProcess.running || chainTimer.running || _stage !== ""
  readonly property bool busy: _working || listProcess.running || typesProcess.running
  readonly property string summary: NetworkManager.nmSummary(profiles)
  readonly property var details: NetworkManager.nmDetails(profiles)
  readonly property var targets: NetworkManager.nmTargets(profiles, root.openconnectAuth)
  readonly property string emptyText: "No profiles yet. Import one with: nmcli connection import type openvpn file <config.ovpn> — or type wireguard file <config.conf>"
  readonly property string currentKey: {
    var profile = NetworkManager.activeNmProfile(profiles)
    return profile ? "profile:" + profile.uuid : ""
  }

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // Probing only. `detected` depends on the profile list, so the controller
  // keeps calling this on a machine that has the tools and no profiles — but
  // the discovery that would settle that question belongs in refresh(), which
  // the controller skips for a hidden tool. Falling through to it here would
  // poll a tool the user switched off. The binaries do not come and go, so once
  // probed this is nothing rather than three more processes every poll.
  function detect(force) {
    if (nmcliProbe.running || openvpnProbe.running || wireguardProbe.running
        || openconnectProbe.running) return
    if (_probed && force !== true) return
    _probesDone = 0
    nmcliProbe.running = true
    openvpnProbe.running = true
    wireguardProbe.running = true
    openconnectProbe.running = true
  }

  function _probeFinished() {
    root._probesDone += 1
    if (root._probesDone < 4) return
    root._probed = true
    if (root._toolsPresent) root.refresh()
  }

  // The two passes share `listProcess.pending`, so a refresh landing while the
  // second one is still out would hand it a list the details it is holding do
  // not describe. One discovery at a time.
  function refresh() {
    if (!_toolsPresent || listProcess.running || typesProcess.running) return
    listProcess.running = true
  }

  function connectTo(target) {
    if (!detected || _working || !target) return

    // `nmcli --ask` prompts for secrets only, and the OpenVPN username is not
    // one — it lives in vpn.data. Without it the profile authenticates as the
    // empty user and the server rejects it, so point at the fix rather than
    // open a password prompt that cannot succeed. WireGuard has no username at
    // all, and OpenConnect settles identity with the gateway during its own
    // authentication, so this is neither of their problems.
    if (NetworkManager.needsUsername(target) && target.hasUsername === false) {
      lastError = "\"" + target.label + "\" has no username. Set one with: nmcli connection modify "
        + target.label + " +vpn.data username=<user>"
      return
    }

    // An OpenConnect profile is unreachable without the auth dialog, and the
    // helper is what finds it. Saying so beats an activation that fails with
    // nmcli complaining about secrets nobody could have supplied.
    if (target.kind === "openconnect" && !target.command) {
      lastError = "\"" + target.label + "\" needs the OpenConnect auth dialog. Install networkmanager-openconnect."
      return
    }

    _desired = 1
    _pendingTarget = target
    lastError = ""
    // OpenConnect waits on a person at a dialog rather than on the network, and
    // that wait is unbounded — a Duo approval can sit on a phone for a minute.
    actionStatus = target.kind === "openconnect"
      ? "Authenticating with " + (target.gateway || target.label) + "…"
      : "Connecting to " + target.label + "…"

    // NetworkManager will happily run two tunnels at once, and picking one
    // profile is never a request for both. The controller only enforces this
    // between backends, so the profiles inside this one take each other down.
    var active = NetworkManager.activeNmProfile(profiles)
    if (active && active.uuid !== target.uuid) {
      _stage = "handover"
      connectProcess.command = ["nmcli", "connection", "down", "uuid", active.uuid]
    } else {
      _stage = "final"
      connectProcess.command = root.activation(target)
    }
    connectProcess.running = true
  }

  // A target either names its own program or hands arguments to nmcli. Only
  // OpenConnect does the former, because its activation runs the auth dialog
  // first and cannot be spelled as an nmcli invocation.
  function activation(target) {
    if (target && target.command) return target.command
    return ["nmcli"].concat((target && target.args) || [])
  }

  function connectPending() {
    var target = root._pendingTarget
    if (!target) {
      root._stage = ""
      return
    }
    root._stage = "final"
    connectProcess.command = root.activation(target)
    connectProcess.running = true
  }

  function missingSecrets(text) {
    return /no valid secrets|secrets were required|vpn\.secrets/i.test(String(text || ""))
  }

  function disconnect() {
    if (!detected || _working) return

    var active = NetworkManager.activeNmProfile(profiles)
    if (!active) return

    _desired = 0
    _stage = "final"
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
    else if (profiles.length === 0) actionStatus = "Import a profile first"
    else actionStatus = "Pick a profile below"
    actionStatusTimer.restart()
  }

  // A profile is only eligible if the tool that carries its kind is installed:
  // NetworkManager lists an OpenVPN profile whether or not anything can run it.
  function runnable(profile) {
    if (profile.kind === "wireguard") return _wireguardPresent
    if (profile.kind === "openconnect") return _openconnectPresent
    return _openvpnPresent
  }

  function applyProfiles(list) {
    var eligible = []
    for (var i = 0; i < list.length; i++) {
      if (runnable(list[i])) eligible.push(list[i])
    }

    root.profiles = eligible
    if (_desired !== -1 && (NetworkManager.activeNmProfile(eligible) !== null) === (_desired === 1)) _desired = -1
  }

  Timer {
    id: actionStatusTimer
    interval: 2600
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  // Starting the second command from inside onExited would re-enter the process
  // that is still finishing, so the handover hops through the event loop first.
  Timer {
    id: chainTimer
    interval: 0
    repeat: false
    onTriggered: root.connectPending()
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
      root._probeFinished()
    }
  }

  Process {
    id: openvpnProbe
    command: ["omarchy-cmd-present", "openvpn"]
    running: true
    onExited: function(exitCode) {
      root._openvpnPresent = exitCode === 0
      root._probeFinished()
    }
  }

  // `wg` comes with wireguard-tools. The kernel module is what actually carries
  // the tunnel, but NetworkManager loads that itself, and a box with the tools
  // installed is a box where a WireGuard profile is meant to work.
  Process {
    id: wireguardProbe
    command: ["omarchy-cmd-present", "wg"]
    running: true
    onExited: function(exitCode) {
      root._wireguardPresent = exitCode === 0
      root._probeFinished()
    }
  }

  // What OpenConnect needs is not a command on PATH but the auth dialog that
  // networkmanager-openconnect ships, and distributions disagree about where
  // that lives. The helper is asked, so the search exists in one place rather
  // than being restated as a path here that could drift out of agreement with
  // the connect that depends on it.
  Process {
    id: openconnectProbe
    command: [root.openconnectAuth, "--dialog-path"]
    running: true
    onExited: function(exitCode) {
      root._openconnectPresent = exitCode === 0
      root._probeFinished()
    }
  }

  // nmcli rejects the whole call when asked for a field it does not know, so an
  // nmcli too old for FILENAME does not return rows without it — it returns
  // nothing at all, and the backend would silently never appear. The first
  // refusal drops the field and the list is fetched again; volatile-connection
  // filtering is what is lost, which is a stray row rather than no backend.
  property bool _filenameField: true
  readonly property var _listCommand: _filenameField
    ? ["nmcli", "-t", "-f", "NAME,UUID,TYPE,ACTIVE,FILENAME", "connection", "show"]
    : ["nmcli", "-t", "-f", "NAME,UUID,TYPE,ACTIVE", "connection", "show"]

  function unknownField(text) {
    return /not among|unknown field|invalid field|allowed fields/i.test(String(text || ""))
  }

  // Retrying from inside onExited would re-enter the process that is still
  // finishing, the same reason the connect chain hops through the event loop.
  Timer {
    id: listRetry
    interval: 0
    repeat: false
    onTriggered: root.refresh()
  }

  // Every tunnel-shaped connection: `vpn` whichever plugin backs it, plus
  // `wireguard`, which NetworkManager types as its own thing rather than as a
  // VPN plugin.
  Process {
    id: listProcess
    running: false
    command: root._listCommand
    stdout: StdioCollector { id: listStdout; waitForEnd: true }
    stderr: StdioCollector { id: listStderr; waitForEnd: true }
    property var pending: []
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        var failure = String(listStderr.text || "")
        if (root._filenameField && root.unknownField(failure)) {
          root._filenameField = false
          listRetry.restart()
          return
        }
        root.lastError = Shared.elide(failure || "Could not list NetworkManager connections", 140)
        return
      }

      root.lastError = ""
      listProcess.pending = NetworkManager.parseNmcliConnections(String(listStdout.text || ""))
      if (listProcess.pending.length === 0) {
        root.applyProfiles([])
        return
      }

      // Second pass, over the `vpn` rows only: which plugin backs them, and
      // whether a username is set. WireGuard rows need neither — they are
      // already known to be WireGuard, and their keys live in the profile — so
      // asking about them would only fetch empty fields.
      var command = ["nmcli", "-t", "-f", "connection.uuid,vpn.service-type,vpn.data", "connection", "show"]
      var asked = 0
      for (var i = 0; i < listProcess.pending.length; i++) {
        if (listProcess.pending[i].kind !== "vpn") continue
        command.push(listProcess.pending[i].uuid)
        asked += 1
      }

      if (asked === 0) {
        root.applyProfiles(listProcess.pending)
        return
      }

      typesProcess.command = command
      typesProcess.running = true
    }
  }

  Process {
    id: typesProcess
    running: false
    command: []
    stdout: StdioCollector { id: typesStdout; waitForEnd: true }
    stderr: StdioCollector { id: typesStderr; waitForEnd: true }
    onExited: function(exitCode) {
      // One profile deleted between the two passes fails the whole call. That
      // is a reason to keep the list from last time, not to declare the machine
      // has no tunnels: emptying it here drops `detected`, takes the chip away
      // while a tunnel is up, and with it the only way to bring that tunnel
      // down — disconnect() refuses to run undetected.
      if (exitCode !== 0) {
        root.lastError = Shared.elide(
          String(typesStderr.text || "") || "Could not read NetworkManager profile details", 140)
        return
      }

      var details = NetworkManager.parseNmcliVpnDetails(String(typesStdout.text || ""))
      var usable = []
      for (var i = 0; i < listProcess.pending.length; i++) {
        var candidate = listProcess.pending[i]

        // WireGuard skipped the second pass, so it is kept as it stands. A
        // `vpn` row survives only if a plugin this backend can drive is behind
        // it — some third plugin's profile is not something it can.
        if (candidate.kind === "wireguard") {
          usable.push(candidate)
          continue
        }

        var detail = details[candidate.uuid]
        if (!detail) continue

        // The second pass is where a `vpn` row learns which plugin it is, so
        // it is also where OpenConnect stops being indistinguishable from
        // OpenVPN. Everything downstream keys off `kind`.
        if (NetworkManager.isOpenConnectService(detail.serviceType)) {
          candidate.kind = "openconnect"
        } else if (!NetworkManager.isOpenVpnService(detail.serviceType)) {
          continue
        }

        candidate.hasUsername = detail.hasUsername
        candidate.gateway = detail.gateway
        usable.push(candidate)
      }
      root.applyProfiles(usable)
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

      // The old tunnel is down (or refused to come down, which is not a reason
      // to swallow the connect the user asked for). Either way, bring up the
      // one they picked.
      if (root._stage === "handover") {
        root._stage = ""
        chainTimer.restart()
        return
      }

      root._stage = ""
      if (exitCode !== 0) {
        root._desired = -1
        var target = root._pendingTarget
        // OpenConnect has already had its conversation, in the auth dialog the
        // helper raised. Sending it to a terminal would offer `nmcli --ask`,
        // which prompts for a session cookie and a certificate fingerprint by
        // name — nothing a person can type. Its own failure is the honest one.
        var interactive = target && target.kind !== "openconnect"
        if (interactive && root.missingSecrets(output) && target.uuid) {
          root.lastError = "This profile needs credentials — opening a terminal to enter them."
          root.authRequired("nmcli --ask connection up uuid " + target.uuid)
        } else {
          root.lastError = Shared.elide(output.trim() || "nmcli command failed", 140)
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
