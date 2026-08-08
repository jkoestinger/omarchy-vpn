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
  readonly property var rows: backend ? backend.targets : []
  // Tool settings, for the backends that have any. A backend without them
  // simply has no block here.
  readonly property var toggles: backend && backend.toggles ? backend.toggles : []
  readonly property bool settingsAvailable: toggles.length > 0
  readonly property bool settingsVisible: settingsAvailable && settingsExpanded
  readonly property bool switcherVisible: vpn.availableBackends.length > 1
  readonly property bool filterVisible: backend !== null && backend.supportsFilter
  readonly property bool headerHasCursor: cursorActive && focusSection === "header"
  readonly property string statusLine: {
    if (!backend) return "Install Proton VPN, Mullvad, OpenVPN, or WireGuard to use this widget."
    return backend.actionStatus !== "" ? backend.actionStatus : backend.lastError
  }

  function ensureCursor() {
    if (rows.length === 0 && focusSection === "rows") focusSection = "header"
    if (!settingsAvailable && focusSection === "hero") focusSection = "header"
    if (!settingsVisible && focusSection === "toggles") focusSection = settingsAvailable ? "hero" : "header"
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

  function selectBackend(backendId) {
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

  function setHeaderCursor() {
    cursorActive = true
    focusSection = "header"
    if (panelFlick) panelFlick.contentY = 0
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

  function activateCursor() {
    ensureCursor()
    if (!backend) return
    if (focusSection === "header") vpn.toggleActive()
    else if (focusSection === "hero") toggleSettings()
    else if (focusSection === "toggles" && toggles.length > 0) flipToggle(toggleIndex)
    else if (focusSection === "rows" && rows.length > 0) activateRow(rows[rowIndex])
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
    if (!backend || !row) return
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
    focusSection = "rows"
    filterField.text = ""
    if (panelFlick) panelFlick.contentY = 0
    vpn.refreshAll()
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
    function refresh(): string { vpn.refreshAll(); vpn.refreshPublicIp(); return "ok" }
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
      var targets = vpn.active.targets
      for (var i = 0; i < targets.length; i++) {
        var candidate = targets[i]
        if (candidate.key === wanted || candidate.detail === wanted || candidate.label === wanted) {
          vpn.connectVia(vpn.active, candidate)
          return "ok"
        }
      }
      return "unknown target"
    }
    function disconnect(): string {
      if (!vpn.active) return "no backend"
      vpn.active.disconnect()
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
      else if (buttonCode === Qt.MiddleButton) { vpn.refreshAll(); vpn.refreshPublicIp() }
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
        else if (t === "d" || t === "D") { if (root.backend) root.backend.disconnect() }
        else if (t === "r" || t === "R") { vpn.refreshAll(); vpn.refreshPublicIp() }
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
          // left, the one master switch on the right. Both sit above the
          // backend chips because they describe the connection, not the tool.
          Item {
            id: header
            width: parent.width
            implicitHeight: Math.max(ipLabel.implicitHeight, masterSwitch.implicitHeight)
            readonly property bool ringVisible: root.headerHasCursor
            function focusHeader() { root.setHeaderCursor() }

            Item {
              id: ipLabel
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: Math.min(ipRow.implicitWidth, parent.width - masterSwitch.width - Style.space(12))
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

            ToggleSwitch {
              id: masterSwitch
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              visible: root.backend !== null
              checked: vpn.anyConnected
              busy: root.backend ? root.backend.busy : false
              hasCursor: header.ringVisible
              foreground: root.foreground
              onHovered: function(on) { if (on) header.focusHeader() }
              onToggled: vpn.toggleActive()

              PanelToolTip {
                visible: masterSwitch.containsMouse
                text: vpn.anyConnected ? "Disconnect" : "Connect"
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
            color: root.backend && root.backend.lastError !== "" && root.backend.actionStatus === "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Column {
            visible: root.backend !== null && root.backend.details.length > 0
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
            visible: root.backend !== null
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
            visible: root.backend !== null
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: root.filterVisible && root.backend && root.backend.filter !== "" ? "MATCHING" : "CONNECT"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              visible: root.rows.length === 0
              width: parent.width
              text: root.backend ? root.backend.emptyText : ""
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
    readonly property bool isCurrent: root.backend !== null
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
        color: root.foreground
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
          color: root.foreground
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
