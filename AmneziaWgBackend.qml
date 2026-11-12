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
  property bool _awgQuickPresent: false
  property int _probesDone: 0
  property bool _probed: false
  // Asked once, the first time there is a list worth building: does
  // `sudo -n awg-quick ...` work without a password prompt? If so, elevate()
  // prefers it over pkexec so connecting is silent on machines with a NOPASSWD
  // sudoers rule for awg-quick.
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

  // `awg` reads status and `awg-quick` brings tunnels up and down; they ship in
  // the same package but need not both be installed, and a machine with only
  // `awg` would draw a working chip whose every connect fails.
  readonly property bool _toolsPresent: _awgPresent && _awgQuickPresent
  // Having awg-quick is not having anything to connect to, and a chip leading
  // to an empty list is a chip worth not drawing — the same reasoning
  // NetworkManagerBackend applies to a tool with a daemon behind it. The list
  // is not only what is on disk: a tunnel someone started outside the widget
  // counts, which is what keeps the chip there to take it down again.
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

  // Probing only, and once: binaries do not come and go while the shell runs,
  // so a machine that answered "not installed" is asked again only when the
  // user forces it. The listing that `detected` also depends on is started from
  // _probeFinished rather than from here, so this stays a probe.
  function detect(force) {
    if (awgProbe.running || awgQuickProbe.running) return
    if (_probed && force !== true) return
    _probesDone = 0
    awgProbe.running = true
    awgQuickProbe.running = true
  }

  // The one listing a hidden backend gets. `detected` depends on the profile
  // list, so without this a tool switched off once could never be listed in the
  // settings view again — the controller calls `detect()` for a hidden backend
  // and nothing else, so the discovery has to hang off the end of probing. Once
  // per shell, not once per poll: `refresh()` from here and the contract's "no
  // polling for a hidden tool" both hold. NetworkManagerBackend does the same.
  function _probeFinished() {
    root._probesDone += 1
    if (root._probesDone < 2) return
    root._probed = true
    if (root._toolsPresent) root.refresh()
  }

  function refresh() {
    if (!_toolsPresent || listProcess.running || statusProcess.running) return
    // Deferred until something is actually going to be listed, so a machine
    // without amneziawg-tools — or one whose owner hid this backend — never
    // spends a sudo invocation, and an auth.log line, on a question about a
    // tool it will not use.
    if (!_sudoProbed && !sudoProbe.running) sudoProbe.running = true
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
  // list carries raw conf paths to the model instead of names the widget
  // invented. The active flag comes from `awg show interfaces`, matched on the
  // interface name awg-quick derives from the basename — and an up interface
  // with no config behind it still gets a row, so it can be taken down. See
  // AmneziaWg.buildProfiles for why that case is not theoretical.
  function applyProfiles(entries) {
    var list = AmneziaWg.buildProfiles(entries, root.upInterfaces)
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

  Process {
    id: awgQuickProbe
    command: ["omarchy-cmd-present", "awg-quick"]
    running: true
    onExited: function(exitCode) {
      root._awgQuickPresent = exitCode === 0
      root._probeFinished()
    }
  }

  // `sudo -n` fails immediately instead of prompting when a password would be
  // required, so this exits 0 only when a NOPASSWD sudoers rule already
  // covers awg-quick for this user.
  Process {
    id: sudoProbe
    command: ["sudo", "-n", "awg-quick", "--help"]
    running: false
    onExited: function(exitCode) {
      root._sudoNoPasswd = exitCode === 0
      root._sudoProbed = true
    }
  }

  // Concatenate every readable profile into one stream for the model to read:
  // a `#awg-profile <path>` header, then the file's lines indented by a tab.
  // The whole config goes through because deciding what is in it — root hooks,
  // endpoint, default route — is a decision, and decisions belong in model/
  // where they are tested. What the shell does is fetch and sanitize: key
  // material is replaced before it leaves the file, since nothing above this
  // line needs it and a private key held in a long-lived QML string is a
  // private key one stray error message away from the panel.
  //
  // awg-quick's own directory is scanned alongside the widget's. Its files are
  // normally root-only, so `-r` skips them and the tunnels they start show up
  // through `awg show interfaces` instead; where they are readable, they list.
  //
  // NUL bytes are deleted on the way out. awg-quick's `read` drops them too, so
  // this is the file as awg-quick will see it — and the hook check must not
  // depend on whether Quickshell keeps such a byte in the stream or cuts the
  // stream short at it, which would take the hook line with it.
  Process {
    id: listProcess
    running: false
    command: [
      "bash", "-c",
      "shopt -s nullglob; " +
      "mkdir -m 0700 -p " + Util.shellQuote(root.profilesDir) + " 2>/dev/null; " +
      "for f in " + Util.shellQuote(root.profilesDir) + "/*.conf /etc/amnezia/amneziawg/*.conf; do " +
      "  [[ -r \"$f\" ]] || continue; " +
      "  printf \"#awg-profile %s\\n\" \"$f\"; " +
      "  tr -d '\\000' < \"$f\" | sed -E 's/^(.*(PrivateKey|PresharedKey)[[:space:]]*=).*$/\\1 [redacted]/I; s/^/\\t/'; " +
      "done"
    ]
    stdout: StdioCollector { id: listStdout; waitForEnd: true }
    stderr: StdioCollector { id: listStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.lastError = Shared.elide(String(listStderr.text || "") || "Could not list AmneziaWG profiles", 140)
        return
      }
      root.lastError = ""
      root._pendingFiles = AmneziaWg.parseProfileBundle(String(listStdout.text || ""))
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
      if (exitCode === 0) {
        root.upInterfaces = AmneziaWg.parseAwgInterfaces(String(statusStdout.text || ""))
        root.lastError = ""
      } else {
        // A failed status read says nothing about a tunnel that may still be
        // up. Keep the last successful answer so its disconnect control stays
        // available instead of presenting a false disconnected state.
        root.lastError = Shared.elide(String(statusStderr.text || "") || "Could not read AmneziaWG status; showing last known connection state", 140)
      }
      root.applyProfiles(root._pendingFiles || [])
      root._pendingFiles = null
      if (!healthProcess.running) healthProcess.running = true
    }
  }

  // Throughput for the up interfaces, from the counters a normal user can read.
  // The config keys that used to be scraped here are read by the model from the
  // listing instead, so this stays two numbers and a name.
  Process {
    id: healthProcess
    running: false
    command: [
      "bash", "-c",
      "for iface in $(awg show interfaces 2>/dev/null); do " +
      "[[ \"$iface\" =~ ^[a-zA-Z0-9_.-]+$ ]] || continue; " +
      "rx=0; tx=0; " +
      "[[ -r \"/sys/class/net/$iface/statistics/rx_bytes\" ]] && read -r rx < \"/sys/class/net/$iface/statistics/rx_bytes\"; " +
      "[[ -r \"/sys/class/net/$iface/statistics/tx_bytes\" ]] && read -r tx < \"/sys/class/net/$iface/statistics/tx_bytes\"; " +
      "printf \"%s\\t%s\\t%s\\n\" \"$iface\" \"$rx\" \"$tx\"; " +
      "done"
    ]
    stdout: StdioCollector { id: healthStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      var now = Date.now()
      var elapsed = root._healthSampleTime > 0 ? Math.max(0.001, (now - root._healthSampleTime) / 1000) : 0
      var merged = AmneziaWg.mergeHealth(root._previousHealth, AmneziaWg.parseSysfsStats(String(healthStdout.text || "")), elapsed)
      root.healthByInterface = merged.health
      if (!merged.sampled) return
      root._previousHealth = merged.health
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
