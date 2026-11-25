// Runs the real helper in a sandbox: PATH holds only the fakes, so no test can
// reach the installed doubletake, the sound server, or systemd.
const { spawn, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const CTL = path.join(__dirname, "..", "bin", "airplay-ctl")
const FAKES = path.join(__dirname, "fakes")

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what)
    await sleep(20)
  }
}

function sandbox(t, { without = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airplay-"))
  const dir = (name) => {
    const made = path.join(root, name)
    fs.mkdirSync(made, { mode: 0o700 })
    return made
  }
  const run = dir("run")
  const log = dir("log")
  const bin = dir("bin")
  const config = dir("config")
  for (const fake of fs.readdirSync(FAKES)) {
    if (!without.includes(fake)) fs.symlinkSync(path.join(FAKES, fake), path.join(bin, fake))
  }

  const daemonState = path.join(root, "daemon.json")
  const pactlState = path.join(root, "pactl.json")
  const activeUnits = path.join(root, "units")
  fs.writeFileSync(daemonState, "{}")
  fs.writeFileSync(pactlState, JSON.stringify({ default: "speakers", sinks: [{ index: 1, name: "speakers" }], inputs: [] }))
  fs.writeFileSync(activeUnits, "")

  const env = {
    PATH: bin,
    XDG_RUNTIME_DIR: run,
    XDG_CONFIG_HOME: config,
    FAKE_LOG: log,
    FAKE_DAEMON_STATE: daemonState,
    FAKE_PACTL_STATE: pactlState,
    FAKE_ACTIVE_UNITS: activeUnits,
    FAKE_SPAWN: "1",
    OMARCHY_AIRPLAY_TICK: "0.05",
    OMARCHY_AIRPLAY_IDLE: "5",
    OMARCHY_AIRPLAY_READY: "3"
  }
  const socketPath = path.join(run, "omarchy-airplay", "daemon.sock")
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
  const pid = (name) => {
    try { return Number(fs.readFileSync(path.join(log, name), "utf8")) } catch (e) { return 0 }
  }
  // A pid of 0 or 1 would address this process group or init, so a missing or
  // malformed pid file must never reach process.kill.
  const signal = (name, sig) => {
    const target = pid(name)
    if (!Number.isInteger(target) || target <= 1) return false
    try { process.kill(target, sig); return true } catch (e) { return false }
  }
  const alive = (name) => signal(name, 0)

  t.after(() => {
    for (const name of ["unit.pid", "doubletake.pid"]) signal(name, "SIGKILL")
    fs.rmSync(root, { recursive: true, force: true })
  })

  return {
    env,
    run,
    config,
    socketPath,
    alive,
    signal,
    pid,
    ctlPath: CTL,
    ctl(args, input = "", extraEnv = {}) {
      const result = spawnSync(CTL, args, { env: { ...env, ...extraEnv }, input, encoding: "utf8", timeout: 20000 })
      let json = null
      try { json = JSON.parse(result.stdout) } catch (e) { /* left null */ }
      return { status: result.status, json, stdout: result.stdout, stderr: result.stderr }
    },
    // Like the shell does it: the code is written to a stdin that stays open.
    ctlKeepingStdinOpen(args, input) {
      return new Promise((resolve) => {
        const child = spawn(CTL, args, { env, stdio: ["pipe", "pipe", "ignore"] })
        let stdout = ""
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, 3000)
        child.stdout.on("data", (chunk) => { stdout += chunk })
        child.on("close", () => {
          clearTimeout(timer)
          let json = null
          try { json = JSON.parse(stdout) } catch (e) { /* left null */ }
          resolve({ timedOut, json })
        })
        child.stdin.write(input)
      })
    },
    async startDaemon(state = {}) {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
      spawn(path.join(bin, "doubletake"), ["-daemonize", "-socket", socketPath], { env, stdio: "ignore" }).unref()
      await waitFor(() => fs.existsSync(socketPath), "the fake daemon's socket")
      fs.writeFileSync(daemonState, JSON.stringify(state))
    },
    daemon: () => readJson(daemonState),
    setDaemon: (state) => fs.writeFileSync(daemonState, JSON.stringify(state)),
    sound: () => readJson(pactlState),
    setSound: (state) => fs.writeFileSync(pactlState, JSON.stringify(state)),
    setActiveUnits: (units) => fs.writeFileSync(activeUnits, units.join("\n")),
    calls(name) {
      try {
        return fs.readFileSync(path.join(log, name + ".jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      } catch (e) {
        return []
      }
    },
    daemonArgv: () => readJson(path.join(log, "doubletake.argv"))
  }
}

module.exports = { sandbox, waitFor, sleep }
