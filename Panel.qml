import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "jkoestinger.vpn"
  ipcTarget: "jkoestinger.vpn"
  manageIpc: false

  // "switcher" | "header" | "hero" | "toggles" | "rows"
  property string focusSection: "rows"
  property int rowIndex: 0
  property int toggleIndex: 0
  // Inside the header: 0 is the gear, 1 the master switch.
  property int headerIndex: 1
  // The widget's own settings, as opposed to the tool's. They replace the body
  // rather than fold out below it: nothing in the connect list means anything
  // while you are deciding which tools the widget should know about.
  property bool providersOpen: false
  // Settings start folded away: they are the part of the panel you touch once
  // and then leave alone. Kept for the session, not per open.
  property bool settingsExpanded: false
  property bool cursorActive: false
  property bool ipCopied: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var backend: vpn.active
  // One tool per row, switch on the right: the whole widget setting is which
  // of the tools on this machine it should bother with.
  readonly property var providerRows: vpn.detectedBackends.map(function(entry) {
    var hidden = vpn.isHidden(entry.backendId)
    return {
      key: "provider:" + entry.backendId,
      backendId: entry.backendId,
      label: entry.label,
      detail: hidden ? "Hidden" : (entry.connected ? "Connected" : "Shown"),
      glyph: entry.glyph,
      hidden: hidden
    }
  })
  readonly property var rows: providersOpen ? providerRows : (backend ? backend.targets : [])
  // Tool settings, for the backends that have any. A backend without them
  // simply has no block here.
  readonly property var toggles: backend && backend.toggles ? backend.toggles : []
  readonly property bool settingsAvailable: !providersOpen && toggles.length > 0
  readonly property bool settingsVisible: settingsAvailable && settingsExpanded
  readonly property bool switcherVisible: !providersOpen && vpn.availableBackends.length > 1
  readonly property bool filterVisible: !providersOpen && backend !== null && backend.supportsFilter
  readonly property bool masterSwitchVisible: backend !== null
  readonly property bool headerHasCursor: cursorActive && focusSection === "header"
  readonly property bool gearHasCursor: headerHasCursor && headerIndex === 0
  readonly property bool switchHasCursor: headerHasCursor && headerIndex === 1
  // The controller's notice outranks the backend's own line: it says why the
  // connect now under way cannot land, which is worth more than watching it
  // report that it is under way.
  readonly property bool statusIsError: vpn.notice !== ""
    || (backend !== null && backend.lastError !== "" && backend.actionStatus === "")
  readonly property string statusLine: {
    if (providersOpen) return ""
    if (vpn.notice !== "") return vpn.notice
    if (!backend) {
      if (vpn.detectedBackends.length > 0) return "Every VPN tool is hidden. Turn one back on with the gear."
      return vpn.setupHint !== ""
        ? vpn.setupHint
        : "Install Proton VPN, Mullvad, OpenVPN, or WireGuard to use this widget."
    }
    return backend.actionStatus !== "" ? backend.actionStatus : backend.lastError
  }

  function ensureCursor() {
    if (rows.length === 0 && focusSection === "rows") focusSection = "header"
    if (!settingsAvailable && focusSection === "hero") focusSection = "header"
    if (!settingsVisible && focusSection === "toggles") focusSection = settingsAvailable ? "hero" : "header"
    if (!switcherVisible && focusSection === "switcher") focusSection = "header"
    // The master switch is gone without a backend, so the gear is all the
    // header has left — and it is the way back from a widget with everything
    // hidden, which is exactly when that happens.
    if (!masterSwitchVisible) headerIndex = 0
    if (headerIndex < 0) headerIndex = 0
    if (headerIndex > 1) headerIndex = 1
    if (rowIndex >= rows.length) rowIndex = Math.max(0, rows.length - 1)
    if (rowIndex < 0) rowIndex = 0
    if (toggleIndex >= toggles.length) toggleIndex = Math.max(0, toggles.length - 1)
    if (toggleIndex < 0) toggleIndex = 0
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()

    if (dx !== 0) {
      if (focusSection === "switcher") stepBackend(dx)
      else if (focusSection === "header") stepHeader(dx)
      return
    }
    if (dy === 0) return

    // Top to bottom: header (address + master switch), backend chips, the hero
    // that folds the settings open, those settings, rows. Each step skips
    // whatever the current backend does not have.
    if (focusSection === "header") {
      if (dy > 0) {
        if (switcherVisible) setSwitcherCursor()
        else stepBelowSwitcher()
      }
      return
    }
    if (focusSection === "switcher") {
      if (dy < 0) setHeaderCursor()
      else stepBelowSwitcher()
      return
    }
    if (focusSection === "hero") {
      if (dy < 0) {
        if (switcherVisible) setSwitcherCursor()
        else setHeaderCursor()
      } else if (settingsVisible) setToggleCursor(0)
      else if (rows.length > 0) setRowCursor(0)
      return
    }
    if (focusSection === "toggles") {
      if (dy < 0 && toggleIndex === 0) {
        setHeroCursor()
        return
      }
      if (dy > 0 && toggleIndex === toggles.length - 1) {
        if (rows.length > 0) setRowCursor(0)
        return
      }
      setToggleCursor(Math.max(0, Math.min(toggles.length - 1, toggleIndex + dy)))
      return
    }
    if (dy < 0 && rowIndex === 0) {
      if (settingsVisible) setToggleCursor(toggles.length - 1)
      else if (settingsAvailable) setHeroCursor()
      else if (switcherVisible) setSwitcherCursor()
      else setHeaderCursor()
      return
    }
    rowIndex = Math.max(0, Math.min(rows.length - 1, rowIndex + dy))
    scrollCursorIntoView()
  }

  function stepBackend(direction) {
    var options = vpn.availableBackends
    if (options.length < 2) return

    var current = 0
    for (var i = 0; i < options.length; i++) {
      if (backend && options[i].backendId === backend.backendId) current = i
    }
    var next = Math.max(0, Math.min(options.length - 1, current + direction))
    selectBackend(options[next].backendId)
  }

  // The filter field belongs to the panel, not to the tool, so it does not
  // travel with the chip. Both ends are cleared on the way across: the outgoing
  // tool would otherwise keep a filter nothing is showing, and the field would
  // sit there full of text the incoming list is not filtered by.
  function selectBackend(backendId) {
    if (root.backend) root.backend.filter = ""
    filterField.text = ""
    vpn.selectBackend(backendId)
    rowIndex = 0
    toggleIndex = 0
    if (panelFlick) panelFlick.contentY = 0
  }

  function setSwitcherCursor() {
    cursorActive = true
    focusSection = switcherVisible ? "switcher" : "header"
    if (panelFlick) panelFlick.contentY = 0
  }

  function setHeaderCursor(index) {
    cursorActive = true
    focusSection = "header"
    if (index !== undefined) headerIndex = index
    if (!masterSwitchVisible) headerIndex = 0
    if (panelFlick) panelFlick.contentY = 0
  }

  function stepHeader(direction) {
    if (!masterSwitchVisible) return
    headerIndex = Math.max(0, Math.min(1, headerIndex + direction))
  }

  function setRowCursor(index) {
    cursorActive = true
    focusSection = "rows"
    rowIndex = index
    scrollCursorIntoView()
  }

  function stepBelowSwitcher() {
    if (settingsAvailable) setHeroCursor()
    else if (rows.length > 0) setRowCursor(0)
  }

  function setHeroCursor() {
    cursorActive = true
    focusSection = "hero"
    if (panelFlick) panelFlick.contentY = 0
  }

  function setToggleCursor(index) {
    cursorActive = true
    focusSection = "toggles"
    toggleIndex = index
    scrollToggleIntoView()
  }

  // Folding the settings away under the cursor would strand it on nothing, so
  // the cursor comes back to the hero that did the folding.
  function toggleSettings() {
    if (!settingsAvailable) return
    settingsExpanded = !settingsExpanded
    if (!settingsExpanded && focusSection === "toggles") setHeroCursor()
    else if (settingsExpanded) setHeroCursor()
  }

  // The gear and the provider rows work without a backend — they are how you
  // get one back — so they are checked before the "nothing detected" bail.
  function activateCursor() {
    ensureCursor()
    if (focusSection === "header") {
      if (headerIndex === 0) toggleProviders()
      else if (backend) vpn.toggleActive()
      return
    }
    if (focusSection === "rows" && rows.length > 0) {
      activateRow(rows[rowIndex])
      return
    }
    if (!backend) return
    if (focusSection === "hero") toggleSettings()
    else if (focusSection === "toggles" && toggles.length > 0) flipToggle(toggleIndex)
  }

  // A view, not a drawer: the cursor stays on the gear that opened it, which is
  // also the way out.
  function toggleProviders() {
    providersOpen = !providersOpen
    rowIndex = 0
    toggleIndex = 0
    if (backend) backend.filter = ""
    filterField.text = ""
    setHeaderCursor(0)
  }

  function toggleProvider(row) {
    if (!row || row.backendId === undefined) return
    var next = Model.toggleBackendId(vpn.hiddenBackendIds, row.backendId)
    saveSetting("hiddenBackends", Model.joinBackendIds(next))
  }

  // Widget settings live in this widget's shell.json entry, the same place the
  // Omarchy settings dialog writes them, so the two agree on the next reload.
  function saveSetting(key, value) {
    var next = {}
    for (var name in settings) {
      if (name !== "id") next[name] = settings[name]
    }
    next[key] = value
    root.settings = next
    if (bar && bar.shell && typeof bar.shell.updateEntryInline === "function") {
      bar.shell.updateEntryInline(root.moduleName, next)
    }
  }

  // Settings go straight to the backend: they change how the tool behaves, not
  // which tunnel is up, so exclusivity has nothing to say about them.
  function flipToggle(index) {
    var entry = toggles[index]
    if (!backend || !entry) return
    backend.setToggle(entry.key, !entry.value)
  }

  function copyPublicIp() {
    if (vpn.publicIp === "") return
    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(vpn.publicIp) + " | wl-copy"])
    ipCopied = true
    ipCopiedTimer.restart()
  }

  function activateRow(row) {
    if (!row) return
    if (providersOpen) {
      toggleProvider(row)
      return
    }
    if (!backend) return
    // Through the controller, never straight to the backend: picking a tunnel
    // means the others come down first.
    vpn.connectVia(backend, row)
  }

  function scrollCursorIntoView() {
    if (focusSection !== "rows" || !rowColumn) return
    if (rowIndex < 0 || rowIndex >= rowColumn.children.length) return
    scrollIntoView(rowColumn.children[rowIndex])
  }

  function scrollToggleIntoView() {
    if (focusSection !== "toggles" || !toggleColumn) return
    if (toggleIndex < 0 || toggleIndex >= toggleColumn.children.length) return
    scrollIntoView(toggleColumn.children[toggleIndex])
  }

  function scrollIntoView(item) {
    if (!panelFlick || !item) return
    Qt.callLater(function() {
      if (!item) return
      var margin = Style.space(6)
      var point = item.mapToItem(panelFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var viewTop = panelFlick.contentY
      var viewBottom = viewTop + panelFlick.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    cursorActive = false
    rowIndex = 0
    toggleIndex = 0
    headerIndex = 1
    // The tool settings stay however you left them; this view does not. You
    // open the panel to connect, not to reconsider which tools exist.
    providersOpen = false
    focusSection = "rows"
    if (backend) backend.filter = ""
    filterField.text = ""
    if (panelFlick) panelFlick.contentY = 0
    // Opening the panel re-probes for tools installed since the shell started;
    // the background poll deliberately does not.
    vpn.refreshAll(true)
    // The address is fetched on connection changes, not on a timer, so a first
    // open with nothing cached is the one other moment worth asking.
    if (vpn.publicIp === "") vpn.refreshPublicIp()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  VpnController {
    id: vpn
    settings: root.settings
  }

  Timer {
    id: ipCopiedTimer
    interval: 1600
    repeat: false
    onTriggered: root.ipCopied = false
  }

  // A backend can hand back a command that only works with a human at a
  // keyboard — NetworkManager asking for VPN credentials it does not store.
  // The panel gets out of the way and lets a terminal own that conversation.
  Connections {
    target: root.backend
    ignoreUnknownSignals: true
    function onAuthRequired(command) {
      if (!root.bar) return
      root.bar.run("omarchy-launch-floating-terminal-with-presentation " + Util.shellQuote(command))
      root.close()
    }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { vpn.refreshAll(true); vpn.refreshPublicIp(); return "ok" }
    function status(): string { return vpn.barSummary }
    function ip(): string { return vpn.publicIp !== "" ? vpn.publicIp : "unknown" }
    function backends(): string {
      return vpn.availableBackends.map(function(b) { return b.backendId }).join(" ")
    }
    function use(backendId: string): string {
      root.selectBackend(backendId)
      return vpn.active ? vpn.active.backendId : "none"
    }
    function connect(target: string): string {
      if (!vpn.active) return "no backend"
      var wanted = String(target || "")
      if (wanted === "") {
        vpn.toggleActive()
        return "ok"
      }
      // A bare country code is the documented shorthand, and it is the row key
      // that spells it the same way for every backend: the detail line does
      // not — Mullvad's carries a city count after the code.
      var byCode = "country:" + wanted.toUpperCase()
      var targets = vpn.active.targets
      for (var i = 0; i < targets.length; i++) {
        var candidate = targets[i]
        if (candidate.key === wanted || candidate.key === byCode
            || candidate.detail === wanted || candidate.label === wanted) {
          vpn.connectVia(vpn.active, candidate)
          return "ok"
        }
      }
      return "unknown target"
    }
    function disconnect(): string {
      if (!vpn.active) return "no backend"
      vpn.disconnectActive()
      return "ok"
    }
    // A declared IPC argument is mandatory, so "connect, no target in mind"
    // needs a method of its own rather than an empty string.
    function quickconnect(): string {
      if (!vpn.active) return "no backend"
      if (vpn.active.connected) return "already connected"
      vpn.toggleActive()
      return "ok"
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.GLYPH_VPN
    dimmed: !vpn.anyConnected
    tooltipText: "VPN: " + vpn.barSummary
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) vpn.toggleActive()
      else if (buttonCode === Qt.MiddleButton) { vpn.refreshAll(true); vpn.refreshPublicIp() }
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: filterField.activeFocus
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // hjkl already drive the cursor, so filtering lives behind "/" instead of
      // swallowing plain letters.
      onTextKey: function(t) {
        if (t === "/" && root.filterVisible) filterField.forceActiveFocus()
        // Through the controller, for the same reason connecting is: it is the
        // one that knows about a connect still queued behind a teardown, which
        // is exactly what pressing this is asking to call off.
        else if (t === "d" || t === "D") vpn.disconnectActive()
        else if (t === "r" || t === "R") { vpn.refreshAll(true); vpn.refreshPublicIp() }
        else if (t === "s" || t === "S") { if (root.switcherVisible) root.stepBackend(1) }
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          // Status bar for the whole widget: where traffic is coming out on the
          // left, the gear and the one master switch on the right. All of it
          // sits above the backend chips because it describes the connection
          // and the widget, not whichever tool is being looked at.
          Item {
            id: header
            width: parent.width
            implicitHeight: Math.max(ipLabel.implicitHeight,
              Math.max(gearButton.implicitHeight, masterSwitch.implicitHeight))
            readonly property real controlsWidth: gearButton.width
              + (masterSwitch.visible ? masterSwitch.width + Style.space(8) : 0)
              + Style.space(12)

            Item {
              id: ipLabel
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: Math.min(ipRow.implicitWidth, parent.width - header.controlsWidth)
              height: ipRow.implicitHeight

              // Only an address is worth copying; a placeholder is not.
              readonly property bool copyable: vpn.publicIp !== "" && !vpn.ipFetching

              Row {
                id: ipRow
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(6)

                Text {
                  text: "Public IP:"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                Text {
                  text: vpn.ipFetching
                    ? "Checking…"
                    : (vpn.publicIp !== "" ? vpn.publicIp : (vpn.ipFailed ? "unavailable" : "—"))
                  color: ipLabel.copyable ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  elide: Text.ElideRight
                }
              }

              MouseArea {
                id: ipMouse
                anchors.fill: parent
                hoverEnabled: true
                enabled: ipLabel.copyable
                cursorShape: Qt.PointingHandCursor
                onClicked: root.copyPublicIp()
              }

              PanelToolTip {
                visible: ipMouse.containsMouse && ipLabel.copyable
                text: root.ipCopied ? "Copied" : "Click to copy"
                fontFamily: root.fontFamily
              }
            }

            PanelActionButton {
              id: gearButton
              anchors.right: masterSwitch.visible ? masterSwitch.left : parent.right
              anchors.rightMargin: masterSwitch.visible ? Style.space(8) : 0
              anchors.verticalCenter: parent.verticalCenter
              iconText: Model.GLYPH_COG
              tooltipText: root.providersOpen ? "Back" : "Widget settings"
              hasCursor: root.gearHasCursor
              foreground: root.foreground
              fontFamily: root.fontFamily
              onHovered: function(on) { if (on) root.setHeaderCursor(0) }
              onClicked: root.toggleProviders()
            }

            ToggleSwitch {
              id: masterSwitch
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              visible: root.masterSwitchVisible
              // The tool being looked at, not "anything at all". Flipping this
              // calls toggleActive(), which acts on the selected backend — a
              // switch reading "on" because a *different* tool is connected
              // would take that tunnel down and bring this one up instead.
              checked: root.backend ? root.backend.connected : false
              busy: root.backend ? root.backend.busy : false
              hasCursor: root.switchHasCursor
              foreground: root.foreground
              onHovered: function(on) { if (on) root.setHeaderCursor(1) }
              onToggled: vpn.toggleActive()

              PanelToolTip {
                visible: masterSwitch.containsMouse
                text: masterSwitch.checked ? "Disconnect" : "Connect"
                fontFamily: root.fontFamily
              }
            }
          }

          ButtonGroup {
            id: switcher
            visible: root.switcherVisible
            options: vpn.switcherOptions
            value: root.backend ? root.backend.backendId : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
            focusable: false
            cursorIndex: root.focusSection === "switcher" ? 0 : -1
            onChanged: function(v) {
              root.focusSection = "switcher"
              root.selectBackend(v)
            }
            onHovered: function(index, isHovered) {
              if (isHovered) root.setSwitcherCursor()
            }
          }

          // Doubles as the settings drawer's handle when the tool has settings:
          // the chevron is the only affordance, since a tool without any leaves
          // the hero exactly as it was.
          CursorSurface {
            id: heroSurface
            visible: !root.providersOpen
            width: parent.width
            implicitHeight: hero.implicitHeight + Style.spacing.rowPaddingX
            hasCursor: root.cursorActive && root.focusSection === "hero"
            foreground: root.foreground

            PanelHero {
              id: hero
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(4)
              anchors.rightMargin: Style.space(4)
              title: root.backend ? root.backend.label : "VPN"
              meta: root.backend ? root.backend.summary : "Nothing detected"
              foreground: root.foreground
              fontFamily: root.fontFamily
              iconOpacity: vpn.anyConnected ? 1.0 : 0.5
              iconComponent: Component {
                Text {
                  text: root.backend ? root.backend.glyph : Model.GLYPH_VPN
                  color: vpn.anyConnected ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.display
                }
              }
              trailingControl: Component {
                Text {
                  visible: root.settingsAvailable
                  text: root.settingsExpanded ? Model.GLYPH_CHEVRON_UP : Model.GLYPH_CHEVRON_DOWN
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.icon
                }
              }
            }

            MouseArea {
              anchors.fill: parent
              enabled: root.settingsAvailable
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onEntered: root.setHeroCursor()
              onClicked: root.toggleSettings()

              PanelToolTip {
                visible: parent.containsMouse
                text: root.settingsExpanded ? "Hide settings" : "Show settings"
                fontFamily: root.fontFamily
              }
            }
          }

          Text {
            visible: root.statusLine !== ""
            width: parent.width
            text: root.statusLine
            color: root.statusIsError ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Column {
            visible: !root.providersOpen && root.backend !== null && root.backend.details.length > 0
            width: parent.width
            spacing: Style.spacing.labelGap

            Repeater {
              model: root.backend ? root.backend.details : []
              InfoPair {
                required property var modelData
                label: modelData.label
                value: modelData.value
              }
            }
          }

          PanelSeparator {
            visible: root.settingsVisible && root.backend !== null && root.backend.details.length > 0
            foreground: root.foreground
          }

          // Settings the tool itself owns. The switches show what it reports,
          // so changing one from its own CLI shows up here on the next poll.
          Column {
            id: toggleColumn
            visible: root.settingsVisible
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              model: root.toggles
              ToggleRow {
                required property var modelData
                required property int index
                width: toggleColumn.width
                entry: modelData
                cursorIndex: index
              }
            }
          }

          PanelSeparator {
            visible: root.providersOpen || root.backend !== null
            foreground: root.foreground
          }

          TextField {
            id: filterField
            visible: root.filterVisible
            width: parent.width
            foreground: root.foreground
            placeholderText: root.backend ? root.backend.filterPlaceholder : ""
            onTextChanged: {
              if (root.backend) root.backend.filter = text
              root.rowIndex = 0
              if (panelFlick) panelFlick.contentY = 0
            }
            Keys.onEscapePressed: {
              text = ""
              keyCatcher.forceActiveFocus()
            }
            Keys.onReturnPressed: {
              keyCatcher.forceActiveFocus()
              root.setRowCursor(0)
            }
          }

          Column {
            visible: root.providersOpen || root.backend !== null
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: {
                if (root.providersOpen) return "PROVIDERS"
                return root.filterVisible && root.backend && root.backend.filter !== "" ? "MATCHING" : "CONNECT"
              }
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              visible: root.rows.length === 0
              width: parent.width
              text: {
                if (root.providersOpen) return "No VPN tool detected on this machine."
                return root.backend ? root.backend.emptyText : ""
              }
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WordWrap
            }

            Column {
              id: rowColumn
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: root.rows
                TargetRow {
                  required property var modelData
                  required property int index
                  width: rowColumn.width
                  row: modelData
                  cursorIndex: index
                }
              }
            }
          }
        }
      }
    }
  }

  component TargetRow: CursorSurface {
    id: targetRow
    property var row: null
    property int cursorIndex: 0
    // A provider row is the same row with a switch where the check mark goes:
    // it says whether the widget uses that tool, not whether it is connected.
    readonly property bool isProvider: row !== null && row.hidden !== undefined
    // A hidden tool reads as switched off rather than as a row you could pick.
    readonly property bool rowMuted: isProvider && row.hidden === true
    readonly property bool isCurrent: !isProvider
      && root.backend !== null
      && row
      && row.key === root.backend.currentKey

    hasCursor: root.cursorActive && root.focusSection === "rows" && root.rowIndex === cursorIndex
    current: isCurrent
    foreground: root.foreground

    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setRowCursor(targetRow.cursorIndex)
      onClicked: root.activateRow(targetRow.row)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        text: targetRow.row ? targetRow.row.glyph : ""
        color: targetRow.rowMuted ? root.dim : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: rowContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          text: targetRow.row ? targetRow.row.label : ""
          color: targetRow.rowMuted ? root.dim : root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          visible: targetRow.row && targetRow.row.detail !== ""
          text: targetRow.row ? targetRow.row.detail : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Text {
        visible: targetRow.isCurrent
        text: Model.GLYPH_CHECK
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ToggleSwitch {
        visible: targetRow.isProvider
        checked: targetRow.isProvider && !targetRow.row.hidden
        foreground: root.foreground
        // Same reason the tool settings do it: the row owns the click and the
        // cursor ring, so a switch that owned them too would read as a second
        // target inside the first.
        interactive: false
        Layout.alignment: Qt.AlignVCenter
      }
    }
  }

  component ToggleRow: CursorSurface {
    id: toggleRow
    property var entry: null
    property int cursorIndex: 0

    hasCursor: root.cursorActive && root.focusSection === "toggles" && root.toggleIndex === cursorIndex
    foreground: root.foreground

    implicitHeight: toggleContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setToggleCursor(toggleRow.cursorIndex)
      onClicked: root.flipToggle(toggleRow.cursorIndex)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      ColumnLayout {
        id: toggleContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          text: toggleRow.entry ? toggleRow.entry.label : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          visible: toggleRow.entry && toggleRow.entry.detail !== ""
          text: toggleRow.entry ? toggleRow.entry.detail : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      ToggleSwitch {
        checked: toggleRow.entry ? toggleRow.entry.value : false
        busy: toggleRow.entry ? toggleRow.entry.busy === true : false
        foreground: root.foreground
        // The row owns the click and the cursor ring; a switch that owned them
        // too would read as a second target inside the first.
        interactive: false
        Layout.alignment: Qt.AlignVCenter
      }
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""

    width: parent.width
    spacing: Style.space(8)

    InfoLabel { text: label }
    Item { width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth - parent.spacing * 2); height: 1 }
    InfoValue { text: value }
  }

  component InfoLabel: Text {
    color: root.foreground
    opacity: 0.6
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component InfoValue: Text {
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    elide: Text.ElideRight
  }
}
