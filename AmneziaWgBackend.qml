import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "model/Shared.js" as Shared
import "model/AmneziaWg.js" as AmneziaWg

// AmneziaWG backend: plain *.conf profiles in a profiles directory (default
// ~/.config/omarchy/vpn/awg-profiles/), brought up and down with awg-quick from
// amneziawg-tools — the same shape NetworkManagerBackend.qml uses for its
// nmcli calls, but for a tool with no daemon of its own to ask. `awg show
// interfaces` needs no root and reports what is up, so status is pollable
// without elevation; only connect/disconnect need it. Implements the backend
// contract documented in VpnController.qml.
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "amneziawg"
  readonly property string label: "AmneziaWG"
  readonly property var installNames: ["AmneziaWG"]
  readonly property string glyph: Shared.GLYPH_SHIELD
  readonly property bool supportsFilter: false
  readonly property string filterPlaceholder: ""

  property var profiles: []
  property var healthByInterface: ({})
  property var _previousHealth: ({})
  property double _healthSampleTime: 0
  property string actionStatus: ""
  property string lastError: ""

  property bool _awgPresent: false
  property bool _probed: false
  // Detected once at startup: does `sudo -n awg-quick ...` work without a
  // password prompt? If so, elevate() prefers it over pkexec so connecting is
  // silent on machines with a NOPASSWD sudoers rule for awg-quick.
  property bool _sudoNoPasswd: false
  property bool _sudoProbed: false

  function elevate(args) {
    var prefix = root._sudoNoPasswd ? ["sudo", "-n"] : ["pkexec"]
    return prefix.concat(["awg-quick"]).concat(args)
  }

  // -1 follows reality, 0/1 overrides it while a command is in flight, so the
  // switch flips the instant it is clicked instead of waiting a poll cycle.
  property int _desired: -1
  property var _pendingTarget: null
  // "" when nothing is in flight, "handover" while the old tunnel is being
  // taken down, "final" while the picked one comes up.
  property string _stage: ""

  readonly property bool _toolsPresent: _awgPresent
  // Having awg-quick is not having anything to connect to, and unlike
  // NetworkManager this backend cannot discover a profile it did not put
  // there itself — see NetworkManagerBackend for the same reasoning applied
  // to a tool with a daemon behind it.
  readonly property bool detected: _toolsPresent && profiles.length > 0
  readonly property bool _activeNow: AmneziaWg.activeAwgProfile(profiles) !== null
  readonly property bool connected: _desired === -1 ? _activeNow : (_desired === 1)
  readonly property bool _working: connectProcess.running || chainTimer.running || _stage !== ""
  readonly property bool busy: _working || listProcess.running || statusProcess.running
  readonly property string summary: AmneziaWg.awgSummary(profiles)
  readonly property var details: AmneziaWg.awgDetails(profiles, healthByInterface)
  readonly property var targets: AmneziaWg.awgTargets(profiles)
  readonly property string emptyText: "No profiles yet. Drop an AmneziaWG *.conf in " + profilesDir
  // Said instead of the panel's "install a VPN tool" line, which is unhelpful
  // advice for someone who has awg-quick and only lacks a profile.
  readonly property string setupHint: _toolsPresent && profiles.length === 0 ? emptyText : ""
  readonly property var activeProfile: AmneziaWg.activeAwgProfile(profiles)
  readonly property string currentKey: activeProfile ? "profile:" + activeProfile.name : ""

  readonly property string profilesDir: {
    var dir = String(root.setting("profilesDir", "~/.config/omarchy/vpn/awg-profiles"))
    if (dir.indexOf("~/") === 0) dir = (Quickshell.env("HOME") || "") + dir.substring(1)
    return dir
  }

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // Probing only. `detected` depends on the profile list, so the controller
  // keeps calling this on a machine that has awg-quick but no profiles — but
  // the discovery that would settle that belongs in refresh(), which the
  // controller skips for a hidden backend. Once probed this is a no-op.
  function detect(force) {
    if (awgProbe.running) return
    if (_probed && force !== true) return
    awgProbe.running = true
  }

  function _probeFinished() {
    root._probed = true
    if (root._toolsPresent) root.refresh()
  }

  function refresh() {
    if (!_toolsPresent || listProcess.running || statusProcess.running) return
    listProcess.running = true
  }

  function connectTo(target) {
    if (!_toolsPresent || _working || !target || !target.confFile) return

    if (target.blocked || target.hasHooks) {
      root.lastError = "Blocked: profile contains executable root hooks (PostUp/PreUp). Remove hooks to connect."
      root.actionStatus = "Blocked for security"
      actionStatusTimer.restart()
      return
    }

    _desired = 1
    _pendingTarget = target
    lastError = ""
    actionStatus = "Connecting to " + target.label + "…"

    // awg-quick will happily run two tunnels at once, and picking one profile
    // is never a request for both. The controller only enforces this between
    // backends, so the profiles inside this one take each other down: the
    // active tunnel first, then the one that was asked for.
    var active = AmneziaWg.activeAwgProfile(profiles)
    if (active && active.confFile !== target.confFile) {
      _stage = "handover"
      connectProcess.command = root.elevate(["down", active.confFile])
    } else {
      _stage = "final"
      connectProcess.command = root.elevate(["up", target.confFile])
    }
    connectProcess.running = true
  }

  function disconnect() {
    if (!_toolsPresent || _working) return

    var active = AmneziaWg.activeAwgProfile(profiles)
    if (!active) return

    _desired = 0
    _stage = "final"
    lastError = ""
    actionStatus = "Disconnecting…"
    connectProcess.command = root.elevate(["down", active.confFile])
    connectProcess.running = true
  }

  function toggleConnection() {
    if (connected) {
      disconnect()
      return
    }
    // One profile is an unambiguous "the VPN"; several need a pick.
    if (profiles.length === 1) connectTo(targets[0])
    else if (profiles.length === 0) actionStatus = "No profiles. Drop a .conf in " + profilesDir
    else actionStatus = "Pick a profile below"
    actionStatusTimer.restart()
  }

  // A config appearing mid-session (or being renamed) should show up, so the
  // list carries a raw conf path to the parser instead of a name the widget
  // invented. The active flag comes from `awg show interfaces`, matched on the
  // interface name awg-quick derives from the basename.
  function applyProfiles(entries) {
    var list = []
    for (var i = 0; i < entries.length; i++) {
      var item = entries[i]
      var name = AmneziaWg.interfaceFor(item.path)
      if (name === "") continue
      list.push({
        name: name,
        confFile: item.path,
        hasHooks: item.hasHooks === true,
        active: root.upInterfaces.indexOf(name) !== -1
      })
    }
    root.profiles = list
    if (_desired !== -1 && (AmneziaWg.activeAwgProfile(list) !== null) === (_desired === 1)) _desired = -1
  }

  Timer {
    id: actionStatusTimer
    interval: 2600
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Process {
    id: awgProbe
    command: ["omarchy-cmd-present", "awg"]
    running: true
    onExited: function(exitCode) {
      root._awgPresent = exitCode === 0
      root._probeFinished()
    }
  }

  // `sudo -n` fails immediately instead of prompting when a password would be
  // required, so this exits 0 only when a NOPASSWD sudoers rule already
  // covers awg-quick for this user.
  Process {
    id: sudoProbe
    command: ["sudo", "-n", "awg-quick", "--help"]
    running: true
    onExited: function(exitCode) {
      root._sudoNoPasswd = exitCode === 0
      root._sudoProbed = true
    }
  }

  // List *.conf profiles in the profiles directory and scan for dangerous root
  // execution hooks (PostUp/PreUp/PreDown/PostDown) before offering to connect.
  Process {
    id: listProcess
    running: false
    command: [
      "bash", "-c",
      "mkdir -m 0700 -p " + Util.shellQuote(root.profilesDir) + " 2>/dev/null; " +
      "chmod 0700 " + Util.shellQuote(root.profilesDir) + " 2>/dev/null; " +
      "for f in " + Util.shellQuote(root.profilesDir) + "/*.conf; do " +
      "  [[ -r \"$f\" ]] || continue; " +
      "  h=\"safe\"; " +
      "  if grep -Eiq '^[[:space:]]*(preup|postup|predown|postdown)[[:space:]]*=' \"$f\" 2>/dev/null; then " +
      "    h=\"has_hooks\"; " +
      "  elif (($? != 1)); then " +
      "    h=\"has_hooks\"; " +
      "  fi; " +
      "  printf \"%s\\t%s\\n\" \"$f\" \"$h\"; " +
      "done || true"
    ]
    stdout: StdioCollector { id: listStdout; waitForEnd: true }
    stderr: StdioCollector { id: listStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.lastError = Shared.elide(String(listStderr.text || "") || "Could not list AmneziaWG profiles", 140)
        return
      }
      root.lastError = ""
      root._pendingFiles = AmneziaWg.parseProfileListing(String(listStdout.text || ""))
      statusProcess.running = true
    }
  }

  property var _pendingFiles: null
  property var upInterfaces: []

  // `awg show interfaces` needs no root and reports the up interfaces by name.
  // Status lags a beat after awg-quick returns, so the settle timer re-asks a
  // few times before letting _desired lapse.
  Process {
    id: statusProcess
    running: false
    command: ["awg", "show", "interfaces"]
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root.upInterfaces = exitCode === 0
        ? AmneziaWg.parseAwgInterfaces(String(statusStdout.text || ""))
        : []
      root.applyProfiles(root._pendingFiles || [])
      root._pendingFiles = null
      if (!healthProcess.running) healthProcess.running = true
    }
  }

  Process {
    id: healthProcess
    running: false
    command: [
      "bash", "-c",
      "for iface in $(awg show interfaces 2>/dev/null); do " +
      "[[ \"$iface\" =~ ^[a-zA-Z0-9_.-]+$ ]] || continue; " +
      "rx=0; tx=0; ep=\"\"; allowed=\"\"; " +
      "[[ -r \"/sys/class/net/$iface/statistics/rx_bytes\" ]] && read -r rx < \"/sys/class/net/$iface/statistics/rx_bytes\"; " +
      "[[ -r \"/sys/class/net/$iface/statistics/tx_bytes\" ]] && read -r tx < \"/sys/class/net/$iface/statistics/tx_bytes\"; " +
      "conf=" + Util.shellQuote(root.profilesDir) + "/\"${iface}.conf\"; " +
      "if [[ -r \"$conf\" ]]; then " +
      "  while IFS=\"=\" read -r rawk rawv || [[ -n \"$rawk\" ]]; do " +
      "    k=\"${rawk//[[:space:]]/}\"; v=\"${rawv//[[:space:]]/}\"; " +
      "    case \"${k,,}\" in " +
      "      endpoint) ep=\"$v\" ;; " +
      "      allowedips) allowed=\"$v\" ;; " +
      "    esac; " +
      "  done < \"$conf\"; " +
      "fi; " +
      "printf \"%s\\t%s\\t%s\\t%s\\t%s\\n\" \"$iface\" \"$rx\" \"$tx\" \"$ep\" \"$allowed\"; " +
      "done"
    ]
    stdout: StdioCollector { id: healthStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      var now = Date.now()
      var next = AmneziaWg.parseSysfsStats(String(healthStdout.text || ""))
      var previous = root._previousHealth
      var elapsed = root._healthSampleTime > 0 ? Math.max(0.001, (now - root._healthSampleTime) / 1000) : 0
      for (var iface in next) {
        var prior = previous[iface]
        if (prior && elapsed > 0) {
          next[iface].rxRate = Math.max(0, next[iface].rxBytes - prior.rxBytes) / elapsed
          next[iface].txRate = Math.max(0, next[iface].txBytes - prior.txBytes) / elapsed
        }
      }
      root.healthByInterface = next
      root._previousHealth = next
      root._healthSampleTime = now
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
        root.lastError = Shared.elide(output, 140)
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

  // Starting the second command from inside onExited would re-enter the process
  // that is still finishing, so the handover hops through the event loop first.
  Timer {
    id: chainTimer
    interval: 0
    repeat: false
    onTriggered: {
      var target = root._pendingTarget
      if (!target) {
        root._stage = ""
        return
      }
      root._stage = "final"
      connectProcess.command = root.elevate(["up", target.confFile])
      connectProcess.running = true
    }
  }

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
}
