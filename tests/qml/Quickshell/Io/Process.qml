import QtQml

// Stands in for Quickshell.Io.Process. It runs nothing: it records what it was
// asked to run and what went to stdin, and a test ends each run by hand.
//
// Matches what Quickshell 0.3.2's Process was seen doing (a throwaway qs
// config, offscreen):
//  - setting running to true emits started; write() then reaches stdin
//  - a run's output ends (streamFinished) before it exits, and running is
//    already false inside onExited. Service.qml also copes with the reverse
//    order; tests that use it are relying on that, not on Quickshell.
//  - setting running to false only asks the child to stop: running stays true
//    until the child has gone, and its output end and exit still arrive
QtObject {
  id: process

  property var command: []
  property bool running: false
  property bool stdinEnabled: false
  property QtObject stdout: null

  signal started()
  signal exited(int exitCode, int exitStatus)

  // What the test reads: one entry per run, the command minus the program.
  property var runs: []
  // What each run was sent on stdin, by run.
  property var stdin: []
  property bool stopRequested: false

  property bool ending: false

  function write(data) {
    var sent = stdin.slice()
    sent[sent.length - 1] += data
    stdin = sent
  }

  onRunningChanged: {
    if (ending) return
    if (running) {
      runs = runs.concat([command.slice(1)])
      stdin = stdin.concat([""])
      started()
    } else {
      stopRequested = true
      ending = true
      running = true
      ending = false
    }
  }

  // The run's output ends with `text`.
  function endOutput(text) {
    stdout.text = text
    stdout.streamFinished()
  }

  // The run exits. Quickshell reports a SIGTERM as code 15.
  function exitWith(code) {
    stopRequested = false
    ending = true
    running = false
    ending = false
    exited(code || 0, code ? 1 : 0)
  }

  // The run prints `text` and exits, in the order Quickshell was seen to.
  function complete(text) {
    endOutput(text)
    exitWith(0)
  }
}
