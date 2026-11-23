import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// One instance per shell, shared by the widget on every monitor, so a click is
// carried out once and the daemon is polled once. Everything that changes the
// system goes through bin/airplay-ctl, one action at a time; this object only
// reads its answers.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string helper: decodeURIComponent(String(Qt.resolvedUrl("bin/airplay-ctl")).replace(/^file:\/\//, ""))

  // False until the helper has answered once.
  property bool loaded: false
  property var snapshot: Model.parseStatus("{}")
  property string snapshotKey: ""
  readonly property var rows: Model.rows(snapshot)
  readonly property bool installed: snapshot.installed
  readonly property bool daemon: snapshot.daemon
  readonly property bool mirroring: firstWith(["streaming"]) !== null
  readonly property bool pending: firstWith(["connecting", "pin_required"]) !== null
  readonly property string mirrorName: {
    var row = firstWith(["streaming"])
    return row ? row.name : ""
  }

  // "" when the last action worked, its reason otherwise.
  property string lastError: ""
  readonly property string error: lastError !== "" ? lastError : snapshot.error

  property string portRange: "60000-60010"
  // Open panels. The daemon is only kept up while one is open or a receiver
  // is being mirrored to.
  property int watchers: 0
  property var queue: []
  property string busyIp: ""

  function firstWith(states) {
    for (var i = 0; i < rows.length; i++)
      if (states.indexOf(rows[i].state) !== -1) return rows[i]
    return null
  }

  function refresh() {
    if (!statusProcess.running) statusProcess.running = true
  }

  // An unreadable answer leaves the last known state in place. An unchanged
  // one is dropped, so the panel's rows are not rebuilt on every poll.
  function applyStatus(text) {
    var parsed = Model.parseStatus(String(text || ""))
    if (!parsed.ok) return
    loaded = true
    var key = JSON.stringify(parsed)
    if (key === snapshotKey) return
    snapshotKey = key
    snapshot = parsed
  }

  function enqueue(args, secret, quiet) {
    if (queue.length >= 8) return
    queue = queue.concat([{ args: args, secret: secret || "", quiet: quiet === true }])
    pump()
  }

  function pump() {
    if (actionProcess.running || queue.length === 0) return
    var next = queue[0]
    queue = queue.slice(1)
    actionProcess.quiet = next.quiet
    actionProcess.secret = next.secret
    actionProcess.exitSeen = false
    actionProcess.outputSeen = false
    actionProcess.output = ""
    actionProcess.command = [helper].concat(next.args)
    actionProcess.running = true
    watchdog.restart()
  }

  // Exit and end-of-output arrive in no fixed order; wait for both.
  function settle() {
    if (!actionProcess.exitSeen || !actionProcess.outputSeen) return
    finish(Model.actionError(actionProcess.output))
  }

  function finish(problem) {
    watchdog.stop()
    actionProcess.exitSeen = false
    actionProcess.outputSeen = false
    actionProcess.secret = ""
    if (!actionProcess.quiet) lastError = problem
    if (queue.length === 0) busyIp = ""
    refresh()
    Qt.callLater(pump)
  }

  function watch(ports) {
    if (ports) portRange = String(ports)
    watchers += 1
    lastError = ""
    enqueue(["up", portRange])
    refresh()
  }

  function unwatch() {
    watchers = Math.max(0, watchers - 1)
    // The helper refuses to stop a daemon that is mirroring; this only spares
    // the pointless attempt.
    if (watchers === 0 && !mirroring && !pending) enqueue(["down"], "", true)
  }

  function connectTo(ip, ports) {
    if (!Model.validTarget(ip)) return
    if (ports) portRange = String(ports)
    busyIp = ip
    if (!daemon) enqueue(["up", portRange])
    enqueue(["connect", ip])
  }

  function submitCredential(ip, kind, value) {
    if (!Model.validTarget(ip) || !Model.credentialValid(kind, value)) return false
    busyIp = ip
    enqueue(["connect", ip, "--credential-stdin"], value)
    return true
  }

  function disconnectFrom(ip) {
    if (!Model.validTarget(ip)) return
    enqueue(["disconnect", ip])
  }

  function disconnectAll() {
    enqueue(["disconnect"])
  }

  // A probe on load finds a mirror that outlived a shell restart.
  Component.onCompleted: refresh()

  Timer {
    interval: root.watchers > 0 ? 2000 : 5000
    repeat: true
    running: root.watchers > 0 || root.daemon
    onTriggered: root.refresh()
  }

  Timer {
    id: watchdog
    interval: 30000
    onTriggered: {
      if (actionProcess.running) actionProcess.running = false
      root.finish("failed")
    }
  }

  Process {
    id: statusProcess
    command: [root.helper, "status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyStatus(text)
    }
  }

  Process {
    id: actionProcess

    property string secret: ""
    property bool quiet: false
    property bool exitSeen: false
    property bool outputSeen: false
    property string output: ""

    // A code goes over stdin, never argv.
    stdinEnabled: true
    onStarted: {
      if (secret !== "") write(secret + "\n")
      secret = ""
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        actionProcess.output = text
        actionProcess.outputSeen = true
        root.settle()
      }
    }
    onExited: function(exitCode) {
      actionProcess.exitSeen = true
      root.settle()
    }
  }
}
