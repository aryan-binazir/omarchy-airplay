import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// Bar icon plus the popup that lists AirPlay receivers. All state and every
// action live in Service.qml, shared across monitors; this file only draws it.
// Receiver names come off the network, so every Text here is PlainText.
Panel {
  id: root
  moduleName: "aryan-binazir.airplay"
  ipcTarget: "aryan-binazir.airplay"

  // The service can finish loading after the widget; look again until it has.
  property int serviceTick: 0
  readonly property var service: {
    void serviceTick
    return bar && bar.shell && typeof bar.shell.serviceFor === "function"
      ? bar.shell.serviceFor(moduleName) : null
  }
  property bool watching: false

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property string portRange: String(setting("portRange", "60000-60010"))

  // Material Design "cast" and "cast connected" from the bar's Nerd Font.
  readonly property string glyphIdle: String.fromCodePoint(0xF0118)
  readonly property string glyphOn: String.fromCodePoint(0xF0119)
  readonly property string glyphScreen: String.fromCodePoint(0xF0379)

  readonly property var rows: service ? service.rows : []
  readonly property bool ready: !!service && service.loaded
  readonly property bool installed: ready && service.installed
  readonly property bool mirroring: !!service && service.mirroring
  readonly property bool pending: !!service && service.pending

  // The receiver waiting for a code, if any. The editor follows its address,
  // so a reordered list cannot send a code to a different receiver.
  readonly property var prompt: {
    for (var i = 0; i < rows.length; i++)
      if (rows[i].state === "pin_required") return rows[i]
    return null
  }
  readonly property string promptIp: prompt ? prompt.ip : ""
  readonly property string promptKind: prompt && prompt.credentialKind === "password" ? "password" : "pin"
  property string credentialText: ""

  property string cursorIp: ""
  property bool cursorActive: false

  readonly property string heroMeta: {
    if (!ready) return strings.t("status.checking")
    if (!installed) return strings.t("status.notInstalled")
    if (mirroring) return strings.t("status.mirroringTo").arg(service.mirrorName)
    if (pending) return strings.t("status.connecting")
    return strings.t("status.ready")
  }
  readonly property string helpText: {
    if (!ready) return ""
    if (!installed) return strings.t("help.install")
    if (rows.length > 0) return ""
    return service.daemon ? strings.t("help.searching") : strings.t("help.starting")
  }
  readonly property string errorText: {
    if (!installed || service.error === "") return ""
    return service.error === "failed" ? strings.t("error.generic") : service.error
  }

  function rowStatus(row) {
    if (row.state === "streaming") return strings.t("row.mirroring")
    if (row.state === "pin_required") return strings.t("row.waiting")
    if (row.state === "connecting" || (service && service.busyIp === row.ip)) return strings.t("row.connecting")
    return ""
  }

  function rowAt(ip) {
    for (var i = 0; i < rows.length; i++)
      if (rows[i].ip === ip) return rows[i]
    return null
  }

  function moveCursor(dy) {
    if (rows.length === 0 || dy === 0) return
    var index = -1
    for (var i = 0; i < rows.length; i++)
      if (rows[i].ip === cursorIp) index = i
    if (!cursorActive || index === -1) index = dy < 0 ? rows.length - 1 : 0
    else index = Math.max(0, Math.min(rows.length - 1, index + dy))
    cursorActive = true
    cursorIp = rows[index].ip
  }

  function activate(row) {
    if (!service || !row) return
    if (row.state === "idle") service.connectTo(row.ip, portRange)
    else service.disconnectFrom(row.ip)
  }

  function reselect(row) {
    if (service && row && row.state === "streaming") service.reselect(row.ip, portRange)
  }

  function submitCredential() {
    if (!service || promptIp === "") return false
    if (!service.submitCredential(promptIp, promptKind, credentialText)) return false
    credentialText = ""
    return true
  }

  function cancelCredential() {
    credentialText = ""
    if (service && promptIp !== "") service.disconnectFrom(promptIp)
  }

  function syncWatch() {
    var want = opened && !!service
    if (want && !watching) {
      service.watch(portRange)
      watching = true
    } else if (!want && watching) {
      if (service) service.unwatch()
      watching = false
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (opened) cursorActive = false
    syncWatch()
  }
  onServiceChanged: {
    // A replaced service starts with no watchers.
    watching = false
    syncWatch()
  }
  onPromptIpChanged: credentialText = ""
  Component.onDestruction: if (watching && service) service.unwatch()

  Commons.Translations {
    id: strings
    directory: Qt.resolvedUrl("i18n")
  }

  Timer {
    interval: 500
    repeat: true
    running: root.service === null && root.serviceTick < 20
    onTriggered: root.serviceTick += 1
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.mirroring ? root.glyphOn : root.glyphIdle
    dimmed: !root.mirroring && !root.pending
    tooltipText: root.mirroring
      ? strings.t("tooltip.mirroring").arg(root.service.mirrorName)
      : strings.t("tooltip.idle")
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) {
        if (root.service) root.service.disconnectAll()
      } else {
        root.toggle()
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight, Style.space(520))

    content: PanelKeyCatcher {
      id: keyCatcher
      implicitHeight: column.implicitHeight
      anchors.fill: parent
      // The code field owns the keyboard while a receiver waits for one.
      blocked: root.promptIp !== ""
      onMoveRequested: function(dx, dy) { root.moveCursor(dy) }
      onActivateRequested: if (root.cursorActive) root.activate(root.rowAt(root.cursorIp))
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Connections {
        target: root
        function onPromptIpChanged() {
          credentialField.text = ""
          if (root.promptIp === "") keyCatcher.forceActiveFocus()
          else Qt.callLater(credentialField.forceActiveFocus)
        }
      }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: strings.t("title")
          meta: root.heroMeta
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconOpacity: root.mirroring ? 1.0 : 0.5
          iconComponent: Component {
            Text {
              textFormat: Text.PlainText
              text: root.mirroring ? root.glyphOn : root.glyphIdle
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
        }

        Text {
          visible: root.errorText !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: root.errorText
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Column {
          visible: root.promptIp !== ""
          width: parent.width
          spacing: Style.space(6)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: (root.promptKind === "password" ? strings.t("prompt.password") : strings.t("prompt.pin"))
              .arg(root.prompt ? root.prompt.name : "")
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          RowLayout {
            width: parent.width
            spacing: Style.space(6)

            TextField {
              id: credentialField
              Layout.fillWidth: true
              password: root.promptKind === "password"
              maximumLength: root.promptKind === "password" ? 128 : 4
              inputMethodHints: root.promptKind === "password" ? Qt.ImhNone : Qt.ImhDigitsOnly
              placeholderText: root.promptKind === "password"
                ? strings.t("prompt.passwordPlaceholder") : strings.t("prompt.pinPlaceholder")
              foreground: root.foreground
              onTextChanged: if (text !== root.credentialText) root.credentialText = text
              onAccepted: if (root.submitCredential()) text = ""
              Keys.onEscapePressed: {
                text = ""
                root.cancelCredential()
              }
              onVisibleChanged: if (visible) Qt.callLater(forceActiveFocus)
            }

            PanelActionButton {
              iconText: String.fromCodePoint(0xF012C)
              foreground: root.foreground
              fontFamily: root.fontFamily
              Layout.alignment: Qt.AlignVCenter
              onClicked: if (root.submitCredential()) credentialField.text = ""
            }
          }
        }

        PanelSeparator {
          foreground: root.foreground
        }

        Text {
          visible: root.helpText !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: root.helpText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        Column {
          id: receiverList
          visible: root.installed && root.rows.length > 0
          width: parent.width
          spacing: Style.space(6)

          PanelSectionHeader {
            text: strings.t("section.receivers")
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Repeater {
            model: root.rows
            ReceiverRow {
              required property var modelData
              width: receiverList.width
              entry: modelData
            }
          }
        }
      }
    }
  }

  component ReceiverRow: CursorSurface {
    id: row
    property var entry: null
    readonly property bool live: !!entry && entry.state !== "idle"
    readonly property string statusText: entry ? root.rowStatus(entry) : ""

    hasCursor: root.cursorActive && !!entry && root.cursorIp === entry.ip && root.promptIp === ""
    current: !!entry && entry.state === "streaming"
    foreground: root.foreground
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      onContainsMouseChanged: if (containsMouse && row.entry) {
        root.cursorActive = true
        root.cursorIp = row.entry.ip
      }
      onClicked: function(mouse) {
        if (mouse.button === Qt.RightButton) root.reselect(row.entry)
        else root.activate(row.entry)
      }
    }

    RowLayout {
      id: rowContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: row.live ? root.glyphOn : root.glyphIdle
        color: row.live ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          textFormat: Text.PlainText
          text: row.entry ? row.entry.name : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          visible: text !== ""
          textFormat: Text.PlainText
          text: row.entry ? row.entry.model : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Text {
        visible: text !== ""
        textFormat: Text.PlainText
        text: row.statusText
        color: row.live ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        Layout.alignment: Qt.AlignVCenter
      }

      PanelActionButton {
        visible: !!row.entry && row.entry.state === "streaming"
        iconText: root.glyphScreen
        tooltipText: strings.t("row.changeScreen")
        foreground: root.foreground
        fontFamily: root.fontFamily
        Layout.alignment: Qt.AlignVCenter
        onClicked: root.reselect(row.entry)
      }
    }
  }
}
