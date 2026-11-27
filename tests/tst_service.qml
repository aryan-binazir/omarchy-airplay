import QtQuick
import QtTest

TestCase {
  name: "Service"

  readonly property string tv: "10.0.0.9"
  readonly property string ok: '{"ok": true}'

  property var service: null
  property var status: null
  property var action: null
  property var watchdog: null

  function init() {
    var component = Qt.createComponent(Qt.resolvedUrl("../Service.qml"))
    verify(component.status === Component.Ready, component.errorString())
    service = component.createObject(null)
    var oneShotTimers = []
    for (var i = 0; i < service.data.length; i++) {
      var child = service.data[i]
      if (child.stopRequested !== undefined)
        child.command[1] === "status" ? status = child : action = child
      else if (child.repeat === false)
        oneShotTimers.push(child)
    }
    verify(status && action, "both processes found")
    compare(oneShotTimers.length, 1, "one watchdog")
    watchdog = oneShotTimers[0]
  }

  function cleanup() {
    service.destroy()
    service = status = action = watchdog = null
  }

  function completeAndAwaitNext(text) {
    var started = action.runs.length
    action.complete(text === undefined ? ok : text)
    tryVerify(function() { return action.runs.length === started + 1 }, 1000, "next action started")
  }

  function test_status_probe_fills_the_panel_and_survives_an_unreadable_answer() {
    compare(status.runs, [["status"]])
    compare(service.loaded, false)

    status.complete(JSON.stringify({
      installed: true, daemon: true,
      devices: [{ name: "Living Room", ip: tv }, { name: "Den", ip: "10.0.0.7" }],
      streams: [
        { device: "Living Room", device_ip: tv, state: "streaming" },
        { device: "Den", device_ip: "10.0.0.7", state: "connecting" }
      ]
    }))
    compare(service.loaded, true)
    compare(service.installed, true)
    compare(service.daemon, true)
    compare(service.rows.length, 2)
    compare(service.mirroring, true)
    compare(service.mirrorName, "Living Room")
    compare(service.pending, true)

    service.refresh()
    compare(status.runs.length, 2)
    status.complete("not json")
    compare(service.loaded, true)
    compare(service.daemon, true)
    compare(service.rows.length, 2)
    compare(service.mirrorName, "Living Room")
    compare(service.pending, true)
  }

  function test_actions_run_one_at_a_time_in_order() {
    service.connectTo(tv, "61000-61010")
    service.disconnectFrom(tv)
    service.disconnectAll()
    compare(action.runs, [["connect", tv, "61000-61010"]])
    compare(service.busyIp, tv)
    completeAndAwaitNext()
    compare(service.busyIp, tv)
    completeAndAwaitNext()
    action.complete(ok)
    compare(service.busyIp, "")
    compare(action.runs, [["connect", tv, "61000-61010"], ["disconnect", tv], ["disconnect"]])
  }

  function test_at_most_eight_actions_wait_behind_the_running_one() {
    service.disconnectAll()
    for (var i = 1; i <= 9; i++) service.disconnectFrom("10.0.0." + i)
    for (var n = 0; n < 8; n++) completeAndAwaitNext()
    action.complete(ok)
    wait(50)
    compare(action.runs.length, 9)
    compare(action.runs[1], ["disconnect", "10.0.0.1"])
    compare(action.runs[8], ["disconnect", "10.0.0.8"])
  }

  function test_a_code_the_full_queue_drops_is_not_reported_as_sent() {
    service.disconnectAll()
    for (var i = 1; i <= 8; i++) service.disconnectFrom("10.0.0." + i)
    compare(service.submitCredential(tv, "pin", "6842"), false)
    for (var n = 0; n < 8; n++) completeAndAwaitNext()
    action.complete(ok)
    wait(50)
    compare(action.runs.length, 9)
    compare(action.runs[8], ["disconnect", "10.0.0.8"])
    compare(action.stdin.join(""), "")
  }

  function test_result_waits_for_both_output_and_exit() {
    service.connectTo(tv)
    action.endOutput('{"ok": false, "error": "receiver refused"}')
    compare(service.error, "")
    action.exitWith(1)
    compare(service.error, "receiver refused")
  }

  function test_result_waits_for_both_in_the_unobserved_exit_first_order() {
    service.connectTo(tv)
    action.exitWith(1)
    compare(service.error, "")
    action.endOutput("")
    compare(service.error, "failed")
  }

  function test_daemon_runs_while_any_panel_is_open_and_stops_quietly() {
    service.watch("61000-61010")
    service.watch("61000-61010")
    compare(service.watchers, 2)
    compare(action.runs, [["up", "61000-61010"]])
    completeAndAwaitNext('{"ok": false, "error": "port busy"}')
    compare(service.error, "port busy")
    action.complete(ok)
    compare(service.error, "")

    service.connectTo(tv)
    action.complete('{"ok": false, "error": "receiver refused"}')
    service.unwatch()
    compare(service.watchers, 1)
    wait(50)
    compare(action.runs.length, 3)
    service.unwatch()
    compare(service.watchers, 0)
    compare(action.runs[3], ["down"])
    action.complete('{"ok": false, "error": "down failed"}')
    compare(service.error, "receiver refused")
  }

  function test_code_goes_to_its_own_run_over_stdin_never_argv() {
    service.disconnectAll()
    service.disconnectFrom("10.0.0.7")
    verify(service.submitCredential(tv, "pin", "6842"))
    compare(service.busyIp, tv)
    service.disconnectFrom(tv)
    completeAndAwaitNext()
    completeAndAwaitNext()
    compare(action.runs[2], ["answer", tv])
    tryVerify(function() { return action.stdin[2] === "6842\n" }, 1000, "code sent")
    completeAndAwaitNext()
    action.complete(ok)
    compare(action.stdin, ["", "", "6842\n", ""])
  }

  function test_invalid_requests_never_reach_the_helper() {
    service.connectTo("10.0.0.999")
    compare(service.submitCredential(tv, "pin", "12345"), false)
    compare(service.busyIp, "")
    compare(action.runs, [])
  }

  function test_stuck_action_is_stopped_and_the_next_waits_for_it_to_exit() {
    service.connectTo(tv)
    service.disconnectAll()
    verify(watchdog.running)
    watchdog.triggered()
    verify(action.stopRequested)
    compare(service.error, "failed")
    wait(50)
    compare(action.runs.length, 1)
    action.endOutput("")
    action.exitWith(15, true)
    tryVerify(function() { return action.runs.length === 2 }, 1000)
    compare(action.runs[1], ["disconnect"])
  }
}
