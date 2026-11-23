const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

test("a missing doubletake is reported as not installed", () => {
  const status = Model.parseStatus('{"installed":false}')
  assert.equal(status.ok, true)
  assert.equal(status.installed, false)
  assert.equal(status.daemon, false)
  assert.deepEqual(status.devices, [])
  assert.deepEqual(status.streams, [])
})

test("a stopped daemon is reported as installed but down", () => {
  const status = Model.parseStatus('{"installed":true,"daemon":false}')
  assert.equal(status.ok, true)
  assert.equal(status.installed, true)
  assert.equal(status.daemon, false)
})

test("output that is not a JSON object is not ok", () => {
  for (const text of ["", "not json", "[]", "null", "42"]) {
    assert.equal(Model.parseStatus(text).ok, false, JSON.stringify(text))
  }
})

test("oversized output is refused", () => {
  const text = JSON.stringify({ installed: true, daemon: true, error: "x".repeat(300000) })
  assert.equal(Model.parseStatus(text).ok, false)
})

test("devices and streams are read from a running daemon", () => {
  const status = Model.parseStatus(JSON.stringify({
    installed: true,
    daemon: true,
    state: "streaming",
    error: "",
    devices: [{ name: "Living Room", model: "AppleTV14,1", ip: "192.168.1.20", port: 7000, device_id: "AA:BB" }],
    streams: [{ device: "Living Room", device_ip: "192.168.1.20", state: "streaming", has_audio: true }]
  }))
  assert.equal(status.daemon, true)
  assert.equal(status.state, "streaming")
  assert.deepEqual(status.devices, [{ name: "Living Room", model: "AppleTV14,1", ip: "192.168.1.20" }])
  assert.deepEqual(status.streams, [{ name: "Living Room", ip: "192.168.1.20", state: "streaming", credentialKind: "" }])
})

test("receiver names are flattened to bounded plain text", () => {
  const status = Model.parseStatus(JSON.stringify({
    installed: true,
    daemon: true,
    devices: [{ name: "Living\n\tRoom  ‮1" + "z".repeat(200), model: "<img src=x>", ip: "10.0.0.5" }]
  }))
  assert.equal(status.devices[0].name, ("Living Room 1" + "z".repeat(200)).slice(0, 80))
  assert.equal(status.devices[0].model, "<img src=x>")
})

test("entries without an IP address literal are dropped", () => {
  const status = Model.parseStatus(JSON.stringify({
    installed: true,
    daemon: true,
    devices: [
      { name: "ok4", ip: "192.168.1.20" },
      { name: "ok6", ip: "fe80::1c2d:3e4f" },
      { name: "host", ip: "tv.local" },
      { name: "flag", ip: "-socket" },
      { name: "range", ip: "999.1.1.1" },
      { name: "none" }
    ],
    streams: [{ device: "x", device_ip: "$(reboot)", state: "streaming" }]
  }))
  assert.deepEqual(status.devices.map((d) => d.name), ["ok4", "ok6"])
  assert.deepEqual(status.streams, [])
})

test("an unknown state is treated as idle and the list sizes are capped", () => {
  const devices = []
  for (let i = 0; i < 100; i++) devices.push({ name: "tv" + i, ip: "10.0.0." + (i + 1) })
  const status = Model.parseStatus(JSON.stringify({ installed: true, daemon: true, state: "exploding", devices }))
  assert.equal(status.state, "idle")
  assert.equal(status.devices.length, 32)
})

test("the daemon error is shown as one bounded line", () => {
  const status = Model.parseStatus(JSON.stringify({
    installed: true,
    daemon: true,
    error: "capture failed:\n" + "e".repeat(500)
  }))
  assert.equal(status.error.length, 200)
  assert.equal(status.error.startsWith("capture failed: eee"), true)
})

function running(devices, streams) {
  return Model.parseStatus(JSON.stringify({ installed: true, daemon: true, devices, streams }))
}

test("each receiver becomes a row, with the one being mirrored to first", () => {
  const rows = Model.rows(running(
    [
      { name: "Bedroom", model: "AppleTV11,1", ip: "10.0.0.7" },
      { name: "Living Room", model: "AppleTV14,1", ip: "10.0.0.9" },
      { name: "Kitchen", model: "AudioAccessory5,1", ip: "10.0.0.3" }
    ],
    [{ device: "Living Room", device_ip: "10.0.0.9", state: "streaming" }]
  ))
  assert.deepEqual(rows, [
    { ip: "10.0.0.9", name: "Living Room", model: "AppleTV14,1", state: "streaming", credentialKind: "" },
    { ip: "10.0.0.7", name: "Bedroom", model: "AppleTV11,1", state: "idle", credentialKind: "" },
    { ip: "10.0.0.3", name: "Kitchen", model: "AudioAccessory5,1", state: "idle", credentialKind: "" }
  ])
})

test("a stream to a receiver discovery no longer lists still gets a row", () => {
  const rows = Model.rows(running([], [{ device: "Den", device_ip: "10.0.0.4", state: "connecting" }]))
  assert.deepEqual(rows, [{ ip: "10.0.0.4", name: "Den", model: "", state: "connecting", credentialKind: "" }])
})

test("a receiver waiting for a code says which kind", () => {
  const rows = Model.rows(running(
    [{ name: "Den", ip: "10.0.0.4" }],
    [{ device: "Den", device_ip: "10.0.0.4", state: "pin_required", credential_kind: "pin" }]
  ))
  assert.equal(rows[0].state, "pin_required")
  assert.equal(rows[0].credentialKind, "pin")
})

test("a receiver without a name is shown by its address, and listed once", () => {
  const rows = Model.rows(running([{ name: "", ip: "10.0.0.4" }, { name: "dup", ip: "10.0.0.4" }], []))
  assert.deepEqual(rows.map((row) => row.name), ["10.0.0.4"])
})

test("an on-screen code is exactly four digits", () => {
  assert.equal(Model.credentialValid("pin", "6842"), true)
  for (const value of ["", "684", "68421", "68a2", " 6842", "６８４２"]) {
    assert.equal(Model.credentialValid("pin", value), false, JSON.stringify(value))
  }
})

test("a receiver password is any single line of reasonable length", () => {
  assert.equal(Model.credentialValid("password", "correct horse"), true)
  assert.equal(Model.credentialValid("password", ""), false)
  assert.equal(Model.credentialValid("password", "two\nlines"), false)
  assert.equal(Model.credentialValid("password", "p".repeat(129)), false)
  assert.equal(Model.credentialValid("other", "1234"), false)
})

test("a failed action reports the helper's reason as bounded plain text", () => {
  assert.equal(Model.actionError('{"ok":true}'), "")
  assert.equal(Model.actionError('{"ok":false,"error":"doubletake is not\\ninstalled"}'), "doubletake is not installed")
  assert.equal(Model.actionError('{"ok":false,"error":"' + "e".repeat(500) + '"}').length, 200)
})

test("a failed action with unreadable output still reports a failure", () => {
  assert.equal(Model.actionError(""), "failed")
  assert.equal(Model.actionError("Traceback (most recent call last)"), "failed")
  assert.equal(Model.actionError('{"ok":false}'), "failed")
})
