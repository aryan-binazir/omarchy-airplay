import QtQml

// Matches Quickshell 0.3.2 (src/io/process.cpp, and a throwaway qs config run
// offscreen):
//  - started is emitted later, from the event loop, not inside the running
//    setter; only then does write() reach stdin, and only with stdinEnabled
//  - a run's output ends (streamFinished) before it exits, and running is
//    already false in both handlers
//  - setting running to false only asks the child to stop: running stays true
//    until the child has gone, and its output end and exit still arrive, the
//    exit as a crash
QtObject {
  id: process

  property var command: []
  property bool running: false
  property bool stdinEnabled: false
  property QtObject stdout: null

  signal started()
  signal exited(int exitCode, int exitStatus)

  property var runs: []
  property var stdin: []
  property bool stopRequested: false

  property bool ending: false
  property bool startPending: false

  function write(data) {
    if (!stdinEnabled || startPending || !running) return
    var sent = stdin.slice()
    sent[sent.length - 1] += data
    stdin = sent
  }

  function emitStarted() {
    if (!startPending) return
    startPending = false
    started()
  }

  onRunningChanged: {
    if (ending) return
    if (running) {
      runs = runs.concat([command.slice(1)])
      stdin = stdin.concat([""])
      startPending = true
      Qt.callLater(emitStarted)
    } else {
      stopRequested = true
      ending = true
      running = true
      ending = false
    }
  }

  function gone() {
    emitStarted()
    ending = true
    running = false
    ending = false
  }

  function endOutput(text) {
    gone()
    stdout.text = text
    stdout.streamFinished()
  }

  function exitWith(code, killed) {
    gone()
    stopRequested = false
    exited(code, killed ? 1 : 0)
  }

  function complete(text) {
    endOutput(text)
    exitWith(0)
  }
}
