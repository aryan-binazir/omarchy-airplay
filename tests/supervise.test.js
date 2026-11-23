const test = require("node:test")
const assert = require("node:assert/strict")
const { sandbox, waitFor, sleep } = require("./harness.js")

const SPEAKERS = { index: 1, name: "speakers" }
const MIRROR = { index: 2, name: "doubletake" }
const HEADPHONES = { index: 3, name: "headphones" }
const browser = (sink) => ({ index: 5, sink, properties: { "application.name": "Firefox" } })
const tuning = { index: 6, sink: 1, properties: { "media.name": "speaker tuning output" } }
const mirrorTo = (extra = {}) => ({ streams: [{ device: "TV", device_ip: "10.0.0.9", state: "streaming", has_audio: true, ...extra }] })

const sinkOf = (box, input) => box.sound().inputs.find((entry) => entry.index === input).sink
const routedTo = (box, name) => () => box.sound().default === name
const stopped = (box) => () => !box.alive("unit.pid") && !box.alive("doubletake.pid")

function start(t, env = {}) {
  const box = sandbox(t)
  box.setSound({ default: "speakers", sinks: [SPEAKERS, MIRROR, HEADPHONES], inputs: [browser(1), tuning] })
  assert.deepEqual(box.ctl(["up"], "", env).json, { ok: true })
  return box
}

async function mirroringWithSound(t, env = {}) {
  const box = start(t, env)
  box.setDaemon(mirrorTo())
  await waitFor(routedTo(box, "doubletake"), "sound to follow the mirror")
  await waitFor(() => sinkOf(box, 5) === 2, "the browser to move to the TV")
  return box
}

test("sound follows the mirror to the TV, leaving audio processing where it is", async (t) => {
  const box = await mirroringWithSound(t)
  assert.equal(sinkOf(box, 5), 2)
  assert.equal(sinkOf(box, 6), 1)
})

test("sound returns to the previous output when mirroring stops", async (t) => {
  const box = await mirroringWithSound(t)
  box.setDaemon({ streams: [] })
  await waitFor(routedTo(box, "speakers"), "sound to return")
  await waitFor(() => sinkOf(box, 5) === 1, "the browser to return")
})

test("sound returns even when doubletake has already removed its output", async (t) => {
  const box = await mirroringWithSound(t)
  box.setSound({ default: "headphones", sinks: [SPEAKERS, HEADPHONES], inputs: [browser(3), tuning] })
  box.setDaemon({ streams: [] })
  await waitFor(routedTo(box, "speakers"), "sound to return")
  await waitFor(() => sinkOf(box, 5) === 1, "the browser to return")
})

test("an output picked by hand while mirroring is kept afterwards", async (t) => {
  const box = await mirroringWithSound(t)
  box.setSound({ default: "headphones", sinks: [SPEAKERS, MIRROR, HEADPHONES], inputs: [browser(3), tuning] })
  await sleep(300)
  box.setDaemon({ streams: [] })
  await waitFor(stopped(box), "the service to stop")
  assert.equal(box.sound().default, "headphones")
  assert.equal(sinkOf(box, 5), 3)
})

test("a mirror without audio leaves sound alone", async (t) => {
  const box = start(t)
  box.setDaemon(mirrorTo({ has_audio: false }))
  await sleep(400)
  assert.equal(box.sound().default, "speakers")
  assert.equal(sinkOf(box, 5), 1)
})

test("sound is left alone when it is unclear which output is doubletake's", async (t) => {
  const box = sandbox(t)
  const second = { index: 4, name: "doubletake_0123456789abcdef" }
  box.setSound({ default: "speakers", sinks: [SPEAKERS, MIRROR, second], inputs: [browser(1)] })
  box.ctl(["up"])
  box.setDaemon(mirrorTo())
  await sleep(400)
  assert.equal(box.sound().default, "speakers")
})

test("stopping the service restores sound and ends the daemon", async (t) => {
  const box = await mirroringWithSound(t)
  box.signal("unit.pid", "SIGTERM")
  await waitFor(routedTo(box, "speakers"), "sound to return")
  await waitFor(stopped(box), "the service to stop")
  assert.equal(sinkOf(box, 5), 1)
})

test("sound is restored when doubletake dies", async (t) => {
  const box = await mirroringWithSound(t)
  box.signal("doubletake.pid", "SIGKILL")
  await waitFor(routedTo(box, "speakers"), "sound to return")
  await waitFor(() => !box.alive("unit.pid"), "the service to stop")
})

test("restore-audio puts sound back after the service was killed outright", async (t) => {
  const box = await mirroringWithSound(t)
  box.signal("unit.pid", "SIGKILL")
  await waitFor(() => !box.alive("unit.pid"), "the service to die")
  assert.equal(box.sound().default, "doubletake")

  assert.deepEqual(box.ctl(["restore-audio"]).json, { ok: true })
  assert.equal(box.sound().default, "speakers")
  assert.equal(sinkOf(box, 5), 1)

  box.setSound({ ...box.sound(), default: "headphones" })
  assert.deepEqual(box.ctl(["restore-audio"]).json, { ok: true })
  assert.equal(box.sound().default, "headphones")
})

test("a restore the sound server refuses is kept for the next attempt", async (t) => {
  const box = await mirroringWithSound(t)
  box.signal("unit.pid", "SIGKILL")
  await waitFor(() => !box.alive("unit.pid"), "the service to die")

  box.setSound({ ...box.sound(), fail: ["set-default-sink"] })
  assert.equal(box.ctl(["restore-audio"]).json.ok, false)
  box.setSound({ ...box.sound(), fail: [] })
  assert.deepEqual(box.ctl(["restore-audio"]).json, { ok: true })
  assert.equal(box.sound().default, "speakers")
})

test("starting the service first puts back sound left over from an unclean stop", async (t) => {
  const box = await mirroringWithSound(t)
  box.signal("unit.pid", "SIGKILL")
  box.signal("doubletake.pid", "SIGKILL")
  await waitFor(stopped(box), "everything to die")
  box.setDaemon({ streams: [] })
  assert.deepEqual(box.ctl(["up"]).json, { ok: true })
  await waitFor(routedTo(box, "speakers"), "sound to return")
})

test("the service stops itself once nothing has been mirrored for a while", async (t) => {
  const box = start(t)
  await waitFor(stopped(box), "the service to stop")
})

test("the service keeps running while a receiver is being mirrored to", async (t) => {
  const box = start(t)
  box.setDaemon(mirrorTo({ state: "pin_required", has_audio: false }))
  await sleep(1200)
  assert.equal(box.alive("unit.pid"), true)
  assert.equal(box.ctl(["status"]).json.daemon, true)
})
