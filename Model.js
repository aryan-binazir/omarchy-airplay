// Pure logic for the AirPlay widget: no QML imports, so it also runs under node
// for tests. Everything the helper prints is treated as untrusted and reduced
// to bounded plain text here before any of it reaches the UI.

var MAX_STATUS_BYTES = 262144
var MAX_ENTRIES = 32
var MAX_NAME = 80
var MAX_ERROR = 200
var STATES = ["idle", "discovering", "connecting", "pin_required", "streaming"]

function plainText(value, limit) {
  if (typeof value !== "string") return ""
  return value
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F\s]+/g, " ")
    .trim()
    .slice(0, limit)
}

function isIPv4(text) {
  var parts = text.split(".")
  if (parts.length !== 4) return false
  for (var i = 0; i < 4; i++) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[i]) || Number(parts[i]) > 255) return false
  }
  return true
}

function isIPv6(text) {
  if (text.length > 39 || !/^[0-9A-Fa-f:]+$/.test(text)) return false
  var compressed = text.split("::")
  if (compressed.length > 2) return false
  var groups = text.split(":")
  if (groups.length < 3 || groups.length > 8) return false
  if (compressed.length === 1 && groups.length !== 8) return false
  for (var i = 0; i < groups.length; i++) if (groups[i].length > 4) return false
  return true
}

// Only an address literal may name a receiver: it ends up as an argument to the
// helper, so a hostname or anything option-shaped is refused.
function validTarget(value) {
  return typeof value === "string" && (isIPv4(value) || isIPv6(value))
}

function list(value) {
  return Array.isArray(value) ? value.slice(0, MAX_ENTRIES * 4) : []
}

function parseStatus(text) {
  var empty = { ok: false, installed: false, daemon: false, state: "idle", error: "", devices: [], streams: [] }
  if (typeof text !== "string" || text.length > MAX_STATUS_BYTES) return empty

  var raw
  try { raw = JSON.parse(text) } catch (e) { return empty }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty

  var devices = []
  var rawDevices = list(raw.devices)
  for (var i = 0; i < rawDevices.length && devices.length < MAX_ENTRIES; i++) {
    var device = rawDevices[i]
    if (!device || typeof device !== "object" || !validTarget(device.ip)) continue
    devices.push({ name: plainText(device.name, MAX_NAME), model: plainText(device.model, MAX_NAME), ip: device.ip })
  }

  var streams = []
  var rawStreams = list(raw.streams)
  for (var j = 0; j < rawStreams.length && streams.length < MAX_ENTRIES; j++) {
    var stream = rawStreams[j]
    if (!stream || typeof stream !== "object" || !validTarget(stream.device_ip)) continue
    streams.push({
      name: plainText(stream.device, MAX_NAME),
      ip: stream.device_ip,
      state: STATES.indexOf(stream.state) !== -1 ? stream.state : "idle",
      credentialKind: stream.credential_kind === "pin" || stream.credential_kind === "password"
        ? stream.credential_kind : ""
    })
  }

  return {
    ok: true,
    installed: raw.installed === true,
    daemon: raw.installed === true && raw.daemon === true,
    state: STATES.indexOf(raw.state) !== -1 ? raw.state : "idle",
    error: plainText(raw.error, MAX_ERROR),
    devices: devices,
    streams: streams
  }
}

// One row per receiver, keyed by address. Receivers with a stream come first so
// the one being mirrored to stays at the top; the rest keep discovery order.
function rows(status) {
  var byIp = {}
  var listed = {}
  var active = []
  var idle = []
  var streams = status && Array.isArray(status.streams) ? status.streams : []
  var devices = status && Array.isArray(status.devices) ? status.devices : []

  for (var i = 0; i < streams.length; i++) {
    var stream = streams[i]
    if (byIp[stream.ip]) continue
    var row = { ip: stream.ip, name: stream.name || stream.ip, model: "", state: stream.state, credentialKind: stream.credentialKind }
    byIp[stream.ip] = row
    active.push(row)
  }

  for (var j = 0; j < devices.length; j++) {
    var device = devices[j]
    if (listed[device.ip]) continue
    listed[device.ip] = true
    var existing = byIp[device.ip]
    if (existing) {
      existing.model = device.model
      if (existing.name === existing.ip && device.name !== "") existing.name = device.name
      continue
    }
    var idleRow = { ip: device.ip, name: device.name || device.ip, model: device.model, state: "idle", credentialKind: "" }
    byIp[device.ip] = idleRow
    idle.push(idleRow)
  }

  return active.concat(idle)
}

// An on-screen code is four ASCII digits; a receiver password is one line.
function credentialValid(kind, value) {
  if (typeof value !== "string") return false
  if (kind === "pin") return /^[0-9]{4}$/.test(value)
  if (kind === "password") return value.length > 0 && value.length <= 128 && !/[\u0000-\u001F\u007F]/.test(value)
  return false
}

// What to show after an action: "" when it worked, otherwise the helper's own
// reason, or a generic marker when its output cannot be read.
function actionError(text) {
  var raw
  try { raw = JSON.parse(typeof text === "string" ? text.slice(0, MAX_STATUS_BYTES) : "") } catch (e) { return "failed" }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "failed"
  if (raw.ok === true) return ""
  return plainText(raw.error, MAX_ERROR) || "failed"
}

if (typeof module !== "undefined") {
  module.exports = {
    parseStatus: parseStatus,
    rows: rows,
    credentialValid: credentialValid,
    actionError: actionError,
    validTarget: validTarget
  }
}
