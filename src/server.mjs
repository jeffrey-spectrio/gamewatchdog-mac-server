import http from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";

loadEnv();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = numberEnv("PORT", 8787);
const CONTROL_TOKEN = required("CONTROL_TOKEN");
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || CONTROL_TOKEN;
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const SCREENSHOT_DIR = resolve(process.env.SCREENSHOT_DIR || "./screenshots");
const RETENTION_DAYS = numberEnv("SCREENSHOT_RETENTION_DAYS", 3);
const MAX_BYTES = numberEnv("SCREENSHOT_MAX_GB", 5) * 1024 ** 3;
const COMMAND_TTL_MS = numberEnv("COMMAND_TTL_SECONDS", 3600) * 1000;
const DEVICE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMMANDS = new Set(["RELOGIN_HOME", "EXTEND_30", "CANCEL_AUTO_RELOGIN", "START_FARM", "STOP_FARM", "ENABLE_WATCHDOG", "DISABLE_WATCHDOG", "START_TICKET", "STOP_TICKET", "CAPTURE_SCREEN", "RESTART_GAME"]);

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SCREENSHOT_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, "gamewatchdog.sqlite"));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE IF NOT EXISTS device_status (
    device TEXT PRIMARY KEY, payload TEXT NOT NULL, last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY, device TEXT NOT NULL, command TEXT NOT NULL,
    created_at INTEGER NOT NULL, acknowledged_at INTEGER, result TEXT
  );
  CREATE INDEX IF NOT EXISTS commands_pending ON commands(device, acknowledged_at, created_at);
  CREATE TABLE IF NOT EXISTS screenshots (
    id TEXT PRIMARY KEY, device TEXT NOT NULL, event TEXT NOT NULL,
    path TEXT NOT NULL, captured_at INTEGER NOT NULL, consumed_at INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS screenshots_device_time ON screenshots(device, captured_at DESC);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL,
    kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`);

const clients = new Set();
const authFailures = new Map();
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try { await route(req, res); }
  catch (error) {
    console.error(new Date().toISOString(), error);
    if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    else res.destroy();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url || "/", "http://localhost").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    ws.authenticated = false;
    const timer = setTimeout(() => ws.close(4001, "authentication required"), 5000);
    ws.on("message", raw => {
      if (ws.authenticated) return;
      try {
        const message = JSON.parse(String(raw));
        if (message.type === "auth" && secureEqual(message.token, CONTROL_TOKEN)) {
          ws.authenticated = true; clearTimeout(timer); clients.add(ws);
          ws.send(JSON.stringify({ type: "ready", serverTime: Date.now() }));
        } else ws.close(4003, "unauthorized");
      } catch { ws.close(4002, "invalid message"); }
    });
    ws.on("close", () => { clearTimeout(timer); clients.delete(ws); });
  });
});

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") return serveFile(res, join(import.meta.dirname, "../web/index.html"), "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/app.js") return serveFile(res, join(import.meta.dirname, "../web/app.js"), "text/javascript; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, serverTime: Date.now() });

  if (req.method === "GET" && url.pathname === "/api/control/status") {
    const device = validDevice(url.searchParams.get("device")); if (!device) return sendJson(res, 400, { error: "invalid_device" });
    const row = db.prepare("SELECT payload,last_seen FROM device_status WHERE device=?").get(device);
    return sendJson(res, 200, { status: row ? { ...JSON.parse(row.payload), device, lastSeen: row.last_seen } : null, serverTime: Date.now() });
  }

  // Screenshot viewing is intentionally public; capturing and all controls remain authenticated.
  if (req.method === "GET" && url.pathname === "/api/control/screenshots") return screenshotHistory(res, url);
  const publicScreenshotMatch = url.pathname.match(/^\/api\/control\/screenshots\/([a-f0-9-]+)$/);
  if (req.method === "GET" && publicScreenshotMatch) return historyImage(res, publicScreenshotMatch[1]);

  if (url.pathname.startsWith("/api/device/")) {
    if (!authorize(req, DEVICE_TOKEN, res)) return;
    if (req.method === "POST" && url.pathname === "/api/device/poll") return devicePoll(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/device/ack") return deviceAck(req, res);
    if (req.method === "POST" && url.pathname === "/api/device/screenshot") return deviceScreenshot(req, res, url);
  }

  if (url.pathname.startsWith("/api/control/")) {
    if (!authorize(req, CONTROL_TOKEN, res)) return;
    if (req.method === "POST" && url.pathname === "/api/control/command") return controlCommand(req, res);
    const commandMatch = url.pathname.match(/^\/api\/control\/commands\/([a-f0-9-]+)$/);
    if (req.method === "GET" && commandMatch) return commandStatus(res, commandMatch[1]);
    if (req.method === "GET" && url.pathname === "/api/control/screenshot") return consumeScreenshot(res, url);
  }
  sendJson(res, 404, { error: "not_found" });
}

async function devicePoll(req, res, url) {
  const device = validDevice(url.searchParams.get("device")); if (!device) return sendJson(res, 400, { error: "invalid_device" });
  const body = await readJson(req, 64_000); const now = Date.now();
  db.prepare(`INSERT INTO device_status(device,payload,last_seen) VALUES(?,?,?)
    ON CONFLICT(device) DO UPDATE SET payload=excluded.payload,last_seen=excluded.last_seen`).run(device, JSON.stringify(body), now);
  const command = db.prepare(`SELECT id,command,created_at FROM commands
    WHERE device=? AND acknowledged_at IS NULL AND created_at>=? ORDER BY created_at LIMIT 1`).get(device, now - COMMAND_TTL_MS);
  broadcast({ type: "status", device, status: { ...body, lastSeen: now } });
  sendJson(res, 200, command ? { id: command.id, command: command.command, createdAt: command.created_at } : { command: null });
}

async function deviceAck(req, res) {
  const body = await readJson(req, 32_000); const device = validDevice(body.device);
  if (!device || typeof body.id !== "string") return sendJson(res, 400, { error: "invalid_request" });
  const now = Date.now();
  db.prepare("UPDATE commands SET acknowledged_at=?,result=? WHERE id=? AND device=?").run(now, String(body.result || ""), body.id, device);
  logEvent(device, "COMMAND_ACK", { id: body.id, result: body.result });
  broadcast({ type: "ack", device, id: body.id, result: body.result, at: now });
  sendJson(res, 200, { ok: true });
}

async function controlCommand(req, res) {
  const body = await readJson(req, 32_000); const device = validDevice(body.device);
  if (!device || !COMMANDS.has(body.command)) return sendJson(res, 400, { error: "invalid_command" });
  const command = { id: randomUUID(), device, command: body.command, createdAt: Date.now() };
  db.prepare("INSERT INTO commands(id,device,command,created_at) VALUES(?,?,?,?)").run(command.id, device, command.command, command.createdAt);
  logEvent(device, "COMMAND_QUEUED", command); broadcast({ type: "command", ...command });
  sendJson(res, 202, command);
}

function commandStatus(res, id) {
  const row = db.prepare("SELECT id,device,command,created_at,acknowledged_at,result FROM commands WHERE id=?").get(id);
  if (!row) return sendJson(res, 404, { error: "not_found" });
  sendJson(res, 200, {
    id: row.id, device: row.device, command: row.command, createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at || null, result: row.result || null,
    state: row.acknowledged_at ? "ACKNOWLEDGED" : "QUEUED"
  });
}

async function deviceScreenshot(req, res, url) {
  const device = validDevice(url.searchParams.get("device")); if (!device) return sendJson(res, 400, { error: "invalid_device" });
  if ((req.headers["content-type"] || "").split(";")[0] !== "image/jpeg") return sendJson(res, 415, { error: "jpeg_required" });
  const data = await readBody(req, 8_000_000); const now = Date.now(); const id = randomUUID();
  const event = cleanEvent(req.headers["x-event-type"] || url.searchParams.get("event") || "MANUAL");
  const file = `${now}-${device}-${id}.jpg`; await writeFile(join(SCREENSHOT_DIR, file), data, { flag: "wx" });
  db.prepare("INSERT INTO screenshots(id,device,event,path,captured_at,metadata) VALUES(?,?,?,?,?,?)")
    .run(id, device, event, file, now, JSON.stringify({ bytes: data.length }));
  logEvent(device, "SCREENSHOT", { id, event, bytes: data.length }); broadcast({ type: "screenshot", device, id, event, capturedAt: now });
  sendJson(res, 201, { ok: true, id, size: data.length, capturedAt: now });
}

function consumeScreenshot(res, url) {
  const device = validDevice(url.searchParams.get("device")); if (!device) return sendJson(res, 400, { error: "invalid_device" });
  const row = db.prepare("SELECT * FROM screenshots WHERE device=? AND consumed_at IS NULL ORDER BY captured_at DESC LIMIT 1").get(device);
  if (!row) return sendJson(res, 404, { error: "no_screenshot" });
  db.prepare("UPDATE screenshots SET consumed_at=? WHERE id=?").run(Date.now(), row.id);
  serveImage(res, row);
}

function screenshotHistory(res, url) {
  const device = validDevice(url.searchParams.get("device")); if (!device) return sendJson(res, 400, { error: "invalid_device" });
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const rows = db.prepare("SELECT id,device,event,captured_at,metadata FROM screenshots WHERE device=? ORDER BY captured_at DESC LIMIT ?").all(device, limit);
  sendJson(res, 200, { screenshots: rows.map(r => ({ id: r.id, device: r.device, event: r.event, capturedAt: r.captured_at, metadata: JSON.parse(r.metadata) })) });
}

function historyImage(res, id) {
  const row = db.prepare("SELECT * FROM screenshots WHERE id=?").get(id); if (!row) return sendJson(res, 404, { error: "not_found" });
  serveImage(res, row);
}

function serveImage(res, row) {
  const path = join(SCREENSHOT_DIR, basename(row.path)); if (!existsSync(path)) return sendJson(res, 404, { error: "file_missing" });
  res.writeHead(200, { "content-type": "image/jpeg", "content-length": statSync(path).size, "cache-control": "private, no-store", "x-captured-at": String(row.captured_at), "x-screenshot-id": row.id });
  createReadStream(path).pipe(res);
}

function cleanupScreenshots() {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const expired = db.prepare("SELECT id,path FROM screenshots WHERE captured_at<? ORDER BY captured_at").all(cutoff);
  for (const row of expired) deleteScreenshot(row);
  const rows = db.prepare("SELECT id,path FROM screenshots ORDER BY captured_at DESC").all();
  let total = 0;
  for (const row of rows) {
    const path = join(SCREENSHOT_DIR, basename(row.path)); const size = existsSync(path) ? statSync(path).size : 0; total += size;
    if (total > MAX_BYTES) deleteScreenshot(row);
  }
}
function deleteScreenshot(row) { const path = join(SCREENSHOT_DIR, basename(row.path)); try { unlinkSync(path); } catch {} db.prepare("DELETE FROM screenshots WHERE id=?").run(row.id); }

function authorize(req, expected, res) {
  const ip = clientIp(req); const entry = authFailures.get(ip);
  if (entry && entry.blockedUntil > Date.now()) { sendJson(res, 429, { error: "temporarily_blocked" }); return false; }
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (secureEqual(supplied, expected)) { authFailures.delete(ip); return true; }
  const failures = (entry?.failures || 0) + 1; authFailures.set(ip, { failures, blockedUntil: failures >= 10 ? Date.now() + 15 * 60_000 : 0 });
  sendJson(res, 401, { error: "unauthorized" }); return false;
}
function clientIp(req) {
  const remote = req.socket.remoteAddress || "unknown";
  const localProxy = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!localProxy) return remote;
  return String(req.headers["x-forwarded-for"] || remote).split(",")[0].trim();
}
function secureEqual(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
function validDevice(value) { return typeof value === "string" && DEVICE_RE.test(value) ? value : null; }
function cleanEvent(value) { const text = String(value).toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40); return text || "MANUAL"; }
function logEvent(device, kind, detail) { db.prepare("INSERT INTO events(device,kind,detail,created_at) VALUES(?,?,?,?)").run(device, kind, JSON.stringify(detail), Date.now()); }
function broadcast(message) { const data = JSON.stringify(message); for (const ws of clients) if (ws.authenticated && ws.readyState === 1) ws.send(data); }
function securityHeaders(res) { res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("x-frame-options", "DENY"); res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()"); }
function sendJson(res, status, data) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); }
function serveFile(res, path, type) { res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' blob:; frame-ancestors 'none'" }); createReadStream(path).pipe(res); }
async function readJson(req, max) { return JSON.parse((await readBody(req, max)).toString("utf8")); }
async function readBody(req, max) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error("request_too_large"); chunks.push(chunk); } return Buffer.concat(chunks); }
function required(name) { const value = process.env[name]; if (!value || value.startsWith("replace-")) throw new Error(`${name} is required`); return value; }
function numberEnv(name, fallback) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; }
function loadEnv() { const path = resolve(".env"); if (!existsSync(path)) return; for (const line of readFileSync(path, "utf8").split(/\r?\n/)) { const match = line.match(/^([A-Z0-9_]+)=(.*)$/); if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]; } }

cleanupScreenshots(); setInterval(cleanupScreenshots, 60 * 60_000).unref();
server.listen(PORT, HOST, () => console.log(`GameWatchdog server listening on http://${HOST}:${PORT}`));
