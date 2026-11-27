const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { sandbox, waitFor, sleep } = require("./harness.js")
const Model = require("../Model.js")

const PORTS = "60000-60010"
const TV = { name: "Living Room", model: "AppleTV14,1", ip: "10.0.0.9", port: 7000, device_id: "AA:BB" }

test("status says when doubletake is not installed", (t) => {
  const box = sandbox(t, { without: ["doubletake"] })
  const result = box.ctl(["status"])
  assert.equal(result.status, 0)
  assert.deepEqual(result.json, { installed: false, daemon: false })
})

test("status reports a stopped daemon", (t) => {
  const box = sandbox(t)
  assert.deepEqual(box.ctl(["status"]).json, { installed: true, daemon: false })
})

test("a socket nobody answers on is a stopped daemon", (t) => {
  const box = sandbox(t)
  fs.mkdirSync(path.dirname(box.socketPath), { recursive: true })
  fs.writeFileSync(box.socketPath, "")
  assert.deepEqual(box.ctl(["status"]).json, { installed: true, daemon: false })
})

test("status merges the daemon's streams, receivers and last error, and the widget reads them back as rows", async (t) => {
  const box = sandbox(t)
  const stream = { device: "Lounge", device_ip: "10.0.0.9", state: "pin_required", credential_kind: "pin" }
  await box.startDaemon({ state: "pin_required", error: "earlier failure", devices: [TV], streams: [stream] })
  const result = box.ctl(["status"])
  assert.deepEqual(result.json, {
    installed: true,
    daemon: true,
    state: "pin_required",
    error: "earlier failure",
    devices: [{ name: "Living Room", model: "AppleTV14,1", ip: "10.0.0.9" }],
    streams: [{ device: "Lounge", device_ip: "10.0.0.9", state: "pin_required", credential_kind: "pin", has_audio: false }]
  })

  const status = Model.parseStatus(result.stdout)
  assert.deepEqual([status.ok, status.installed, status.daemon, status.error], [true, true, true, "earlier failure"])
  assert.deepEqual(Model.rows(status), [
    { ip: "10.0.0.9", name: "Lounge", model: "AppleTV14,1", state: "pin_required", credentialKind: "pin" }
  ])
})

test("status stays small whatever the daemon and the network say", async (t) => {
  const box = sandbox(t)
  const devices = []
  for (let i = 0; i < 500; i++) devices.push({ name: "n".repeat(400), model: "m".repeat(400), ip: "10.0.1." + (i % 250), extra: "x".repeat(400) })
  await box.startDaemon({ error: "e".repeat(50000), devices, streams: [{ device: "d".repeat(5000), device_ip: "10.0.0.9", state: "streaming", blob: "b".repeat(5000) }] })
  const result = box.ctl(["status"])
  assert.equal(result.json.daemon, true)
  assert.equal(result.json.devices.length, 64)
  assert.ok(result.stdout.length < 40000, "status was " + result.stdout.length + " bytes")
})

test("a daemon reply too large to be genuine is ignored", async (t) => {
  const box = sandbox(t)
  const devices = []
  for (let i = 0; i < 300; i++) devices.push({ name: "n".repeat(5000), ip: "10.0.1." + (i % 250) })
  await box.startDaemon({ devices })
  const result = box.ctl(["status"])
  assert.equal(result.json.daemon, true)
  assert.deepEqual(result.json.devices, [])
})

test("status changes nothing on the system", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ state: "streaming", streams: [{ device: "TV", device_ip: "10.0.0.9", state: "streaming", has_audio: true }] })
  box.ctl(["status"])
  assert.deepEqual(box.calls("pactl"), [])
  assert.deepEqual(box.calls("systemctl"), [])
  assert.deepEqual(box.calls("systemd-run"), [])
})

const streamTo = (ip, extra = {}) => ({ device: "Receiver " + ip, device_ip: ip, state: "streaming", has_audio: true, ...extra })

test("up starts the daemon in a transient user unit and waits until it answers", (t) => {
  const box = sandbox(t)
  const result = box.ctl(["up", "60000-60010"])
  assert.deepEqual(result.json, { ok: true })

  const [started] = box.calls("systemd-run")
  assert.ok(started.includes("--user"))
  assert.ok(started.includes("--collect"))
  assert.ok(started.includes("--unit=omarchy-airplay.service"))
  assert.ok(started.includes('--property=ExecStopPost="' + box.ctlPath + '" restore-audio'))
  assert.deepEqual(started.slice(started.indexOf("--") + 1), [box.ctlPath, "supervise", "60000-60010"])

  assert.deepEqual(box.daemonArgv(), ["-daemonize", "-socket", box.socketPath, "-port-range", "60000-60010"])
  assert.equal(box.ctl(["status"]).json.daemon, true)
})

test("up does nothing when the daemon already answers", async (t) => {
  const box = sandbox(t)
  await box.startDaemon()
  assert.deepEqual(box.ctl(["up"]).json, { ok: true })
  assert.deepEqual(box.calls("systemd-run"), [])
})

test("up refuses a port range that is malformed or too small", (t) => {
  const box = sandbox(t)
  for (const range of ["1-2;reboot", "60000", "60000-60001", "80-90", "60010-60000", "60000-70000"]) {
    const result = box.ctl(["up", range])
    assert.equal(result.json.ok, false, range)
    assert.equal(result.status, 1, range)
  }
  assert.deepEqual(box.calls("systemd-run"), [])
})

test("up leaves a running doubletake.service alone and says so", (t) => {
  const box = sandbox(t)
  box.setActiveUnits(["doubletake.service"])
  const result = box.ctl(["up"])
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /doubletake\.service/)
  assert.deepEqual(box.calls("systemd-run"), [])
})

test("up replaces a unit of its own whose daemon stopped answering", (t) => {
  const box = sandbox(t)
  box.setActiveUnits(["omarchy-airplay.service"])
  assert.deepEqual(box.ctl(["up"]).json, { ok: true })
  assert.ok(box.calls("systemctl").some((call) => call.join(" ") === "--user stop omarchy-airplay.service"))
  assert.equal(box.calls("systemd-run").length, 1)
})

test("up clears away a unit of its own that is still stopping before reusing its name", (t) => {
  const box = sandbox(t)
  assert.deepEqual(box.ctl(["up"]).json, { ok: true })
  const calls = box.calls("systemctl").map((call) => call.join(" "))
  assert.ok(calls.includes("--user stop omarchy-airplay.service"), calls.join("; "))
})

test("up reports a daemon that never comes up", (t) => {
  const box = sandbox(t)
  const result = box.ctl(["up"], "", { FAKE_SPAWN: "0", OMARCHY_AIRPLAY_READY: "0.3" })
  assert.equal(result.json.ok, false)
})

test("connect starts mirroring to the chosen receiver", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ devices: [TV] })
  assert.deepEqual(box.ctl(["connect", "10.0.0.9", PORTS]).json, { ok: true })
  assert.deepEqual(box.daemon().streams.map((stream) => stream.device_ip), ["10.0.0.9"])
})

test("connect moves the mirror from one receiver to another", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.7")] })
  assert.deepEqual(box.ctl(["connect", "10.0.0.9", PORTS]).json, { ok: true })
  assert.deepEqual(box.daemon().streams.map((stream) => stream.device_ip), ["10.0.0.9"])
})

test("connect to the receiver already being mirrored to is a no-op", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.9")] })
  assert.deepEqual(box.ctl(["connect", "10.0.0.9", PORTS]).json, { ok: true })
  assert.deepEqual(box.calls("requests").filter((request) => request.cmd !== "status"), [])
})

test("connect refuses anything that is not an address literal", async (t) => {
  const box = sandbox(t)
  await box.startDaemon()
  for (const target of ["-socket", "tv.local", "10.0.0.9 10.0.0.7", "fe80::1%eth0", ""]) {
    assert.equal(box.ctl(["connect", target, PORTS]).json.ok, false, target)
  }
  assert.equal(box.ctl(["connect"]).json.ok, false)
  assert.equal(box.ctl(["connect", "10.0.0.9"]).json.ok, false)
  assert.equal(box.ctl(["connect", "10.0.0.9", "80-81"]).json.ok, false)
  assert.deepEqual(box.calls("requests"), [])
})

test("connect starts the service when it is not running", (t) => {
  const box = sandbox(t)
  assert.deepEqual(box.ctl(["connect", "10.0.0.9", PORTS]).json, { ok: true })
  assert.equal(box.calls("systemd-run").length, 1)
  assert.deepEqual(box.daemon().streams.map((stream) => stream.device_ip), ["10.0.0.9"])
})

test("a code typed for a waiting receiver arrives on stdin and completes the connection", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.9", { state: "pin_required", credential_kind: "pin" })] })
  assert.deepEqual(box.ctl(["answer", "10.0.0.9"], "6842\n").json, { ok: true })
  assert.deepEqual(box.calls("requests").filter((request) => request.cmd === "connect"),
    [{ cmd: "connect", target: "10.0.0.9", pin: "6842" }])
  assert.equal(box.daemon().streams[0].state, "streaming")
})

test("a code from a panel older than the answer command still completes the connection", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.9", { state: "pin_required", credential_kind: "pin" })] })
  assert.deepEqual(box.ctl(["connect", "10.0.0.9", "--credential-stdin"], "6842\n").json, { ok: true })
  assert.deepEqual(box.calls("requests").filter((request) => request.cmd === "connect"),
    [{ cmd: "connect", target: "10.0.0.9", pin: "6842" }])
})

test("answer refuses a missing, extra or non-literal receiver before reading a code or asking the daemon", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.9", { state: "pin_required", credential_kind: "pin" })] })
  for (const args of [[], ["10.0.0.9", "60000-60010"], ["tv.local"]]) {
    const result = box.ctl(["answer", ...args], "6842\n")
    assert.equal(result.json.ok, false, args.join(" "))
    assert.equal(result.status, 1, args.join(" "))
    const waiting = await box.ctlKeepingStdinOpen(["answer", ...args], "")
    assert.equal(waiting.timedOut, false, args.join(" "))
    assert.equal(waiting.json.ok, false, args.join(" "))
  }
  assert.deepEqual(box.calls("requests"), [])
})

test("a code for a receiver that is not waiting for one is not sent", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.9")] })
  assert.equal(box.ctl(["answer", "10.0.0.9"], "6842\n").json.ok, false)
  assert.equal(box.ctl(["answer", "10.0.0.7"], "6842\n").json.ok, false)
  assert.deepEqual(box.calls("requests").filter((request) => request.cmd === "connect"), [])
})

test("an empty or multi-line code is refused", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.9", { state: "pin_required", credential_kind: "password" })] })
  for (const input of ["", "\n", "p".repeat(200) + "\n", "tab\there\n"]) {
    assert.equal(box.ctl(["answer", "10.0.0.9"], input).json.ok, false, JSON.stringify(input))
  }
  assert.deepEqual(box.calls("requests").filter((request) => request.cmd === "connect"), [])
})

test("disconnect stops mirroring to one receiver and leaves the others", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.7"), streamTo("10.0.0.9")] })
  assert.deepEqual(box.ctl(["disconnect", "10.0.0.7"]).json, { ok: true })
  assert.deepEqual(box.daemon().streams.map((stream) => stream.device_ip), ["10.0.0.9"])
})

test("disconnect without a receiver stops all mirroring", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.7"), streamTo("10.0.0.9")] })
  assert.deepEqual(box.ctl(["disconnect"]).json, { ok: true })
  assert.deepEqual(box.daemon().streams, [])
})

test("disconnect succeeds when there is nothing to stop", async (t) => {
  const box = sandbox(t)
  assert.deepEqual(box.ctl(["disconnect"]).json, { ok: true })
  await box.startDaemon()
  assert.deepEqual(box.ctl(["disconnect", "10.0.0.9"]).json, { ok: true })
  assert.equal(box.ctl(["disconnect", "tv.local"]).json.ok, false)
})

test("down stops the unit when nothing is being mirrored", async (t) => {
  const box = sandbox(t)
  await box.startDaemon()
  assert.deepEqual(box.ctl(["down"]).json, { ok: true })
  assert.deepEqual(box.calls("systemctl"), [["--user", "stop", "omarchy-airplay.service"]])
})

test("down leaves a receiver that is being mirrored to alone", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.9", { state: "connecting" })] })
  assert.deepEqual(box.ctl(["down"]).json, { ok: true })
  assert.deepEqual(box.calls("systemctl"), [])
  assert.equal(box.daemon().streams.length, 1)
})

test("down leaves a daemon that does not answer alone", (t) => {
  const box = sandbox(t)
  fs.mkdirSync(path.dirname(box.socketPath), { recursive: true })
  fs.writeFileSync(box.socketPath, "")
  assert.deepEqual(box.ctl(["down"]).json, { ok: true })
  assert.deepEqual(box.calls("systemctl"), [])
})

test("a code is accepted as soon as its line arrives, without waiting for stdin to close", async (t) => {
  const box = sandbox(t)
  await box.startDaemon({ streams: [streamTo("10.0.0.9", { state: "pin_required", credential_kind: "pin" })] })
  const result = await box.ctlKeepingStdinOpen(["answer", "10.0.0.9"], "6842\n")
  assert.equal(result.timedOut, false)
  assert.deepEqual(result.json, { ok: true })
})

function saveCredentials(box, saved) {
  const file = path.join(box.config, "doubletake", "credentials.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof saved === "string" ? saved : JSON.stringify(saved))
  return file
}

test("connect restarts a daemon that saved a screen choice, so the picker asks again", async (t) => {
  const box = sandbox(t)
  const file = saveCredentials(box, { "AA:BB": { pairing_id: "p1", restore_token: "screen-1" }, "CC:DD": { pairing_id: "p2" } })
  assert.deepEqual(box.ctl(["up", PORTS]).json, { ok: true })
  const before = box.pid("doubletake.pid")

  assert.deepEqual(box.ctl(["connect", "10.0.0.9", PORTS]).json, { ok: true })
  assert.notEqual(box.pid("doubletake.pid"), before)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { "AA:BB": { pairing_id: "p1" }, "CC:DD": { pairing_id: "p2" } })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(box.daemon().streams.map((stream) => stream.device_ip), ["10.0.0.9"])
})

test("connect keeps a daemon with no saved screen choice", async (t) => {
  const box = sandbox(t)
  saveCredentials(box, { "AA:BB": { pairing_id: "p1" } })
  assert.deepEqual(box.ctl(["up", PORTS]).json, { ok: true })
  const before = box.pid("doubletake.pid")
  assert.deepEqual(box.ctl(["connect", "10.0.0.9", PORTS]).json, { ok: true })
  assert.equal(box.pid("doubletake.pid"), before)
})

test("connect to the receiver already being mirrored to keeps its screen", async (t) => {
  const box = sandbox(t)
  assert.deepEqual(box.ctl(["up", PORTS]).json, { ok: true })
  assert.deepEqual(box.ctl(["connect", "10.0.0.9", PORTS]).json, { ok: true })
  saveCredentials(box, { "AA:BB": { pairing_id: "p1", restore_token: "screen-1" } })
  const before = box.pid("doubletake.pid")
  assert.deepEqual(box.ctl(["connect", "10.0.0.9", PORTS]).json, { ok: true })
  assert.equal(box.pid("doubletake.pid"), before)
})
