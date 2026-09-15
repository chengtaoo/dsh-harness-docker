#!/usr/bin/env node
/**
 * dsh-auth-gateway — licence gate and per-user instance manager.
 *
 *   browser ──► 0.0.0.0:8080 (this gateway)
 *                    └─► 127.0.0.1:3101  dsh web  (licence A, home + workspace A)
 *                    └─► 127.0.0.1:3102  dsh web  (licence B, home + workspace B)
 *
 * Two problems are solved here.
 *
 * 1. Authentication. `dsh web` ships a single-user fence: a per-process launch
 *    token printed once as `/?token=...`, redeemed for an HMAC-signed,
 *    authority-bound cookie. That token rotates every start, so it cannot be
 *    handed to colleagues. This gateway performs the exchange server-side,
 *    holds the resulting cookie itself, and never exposes it to a browser.
 *    Colleagues authenticate only against the licence store.
 *
 * 2. Isolation. One `dsh web` process is one trust domain — a single session
 *    list, workspace registry and DSH_HOME shared by every connected browser.
 *    So the gateway gives each licence its own dsh process, its own DSH_HOME
 *    and its own workspace directory, and routes each browser to its own.
 *    Instances start on first use and are reclaimed after an idle period;
 *    their homes persist, so session history survives a restart.
 *
 * Only Node built-ins are used (node:http, node:net, node:sqlite, node:child_process).
 */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  openDb, migrate, cookieSecret, audit, checkLicense, nowSec,
  activeSessionCount, createSession, getSession, slideSession,
  dropSession, purgeExpiredSessions,
} from './lib.mjs'

const PORT = Number(process.env.GATEWAY_PORT ?? 8080)
const BIND = process.env.GATEWAY_BIND ?? '0.0.0.0'
const DB_PATH = process.env.GATEWAY_DB ?? '/data/auth.db'
const LOG_DIR = process.env.DSH_LOG_DIR ?? '/data/logs'
const USERS_ROOT = process.env.GATEWAY_USERS_ROOT ?? '/data/users'
const WORKSPACE_ROOT = process.env.GATEWAY_WORKSPACE_ROOT ?? '/workspace'
const SESSION_TTL_SECONDS = Number(process.env.GATEWAY_SESSION_TTL_HOURS ?? 12) * 3600
const IDLE_REAP_MS = Number(process.env.GATEWAY_IDLE_MINUTES ?? 30) * 60 * 1000
const MAX_INSTANCES = Number(process.env.GATEWAY_MAX_INSTANCES ?? 20)
const PORT_BASE = Number(process.env.GATEWAY_INSTANCE_PORT_BASE ?? 3100)
const AUTH_DISABLED = process.env.GATEWAY_AUTH_DISABLED === '1'
const DSH_BIN = process.env.DSH_BIN ?? '/app/node_modules/@deepseek-ai/dsh/lib/bin.js'
const ANONYMOUS_KEY = '__anonymous__'

const COOKIE_NAME = 'dsh_gw'
const MAX_LOGIN_FAILURES = 10
const LOGIN_WINDOW_MS = 5 * 60 * 1000
// A warm boot takes ~7s, but the very first dsh start in a fresh container
// loads ~300MB of modules off a cold page cache and is far slower. The
// entrypoint pre-warms that path, and this ceiling covers it if it did not.
const BOOT_TIMEOUT_MS = 180_000

const db = openDb(DB_PATH)
migrate(db)
const SECRET = cookieSecret(db)
fs.mkdirSync(LOG_DIR, { recursive: true })

/* ── gateway session cookies ─────────────────────────────────────────────── */

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url')

function issueCookie(res, sessionId) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${sessionId}.${sign(sessionId)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax`)
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`)
}

function readCookie(headerValue) {
  if (!headerValue) return undefined
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== COOKIE_NAME) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

function authenticate(req) {
  if (AUTH_DISABLED) return { license_key: ANONYMOUS_KEY, id: 'anonymous' }
  const raw = readCookie(req.headers.cookie)
  if (!raw) return undefined
  const at = raw.lastIndexOf('.')
  if (at === -1) return undefined
  const id = raw.slice(0, at)
  const presented = Buffer.from(raw.slice(at + 1), 'utf8')
  const expected = Buffer.from(sign(id), 'utf8')
  if (presented.length !== expected.length) return undefined
  if (!crypto.timingSafeEqual(presented, expected)) return undefined
  const session = getSession(db, id)
  if (!session) return undefined
  // A revoked or expired licence must invalidate its sessions immediately.
  const verdict = checkLicense(db, session.license_key)
  if (!verdict.ok) {
    dropSession(db, id)
    void stopInstance(session.license_key)
    return undefined
  }
  if (nowSec() - session.last_seen_at > 60) slideSession(db, id, SESSION_TTL_SECONDS)
  return session
}

/* ── login throttling ────────────────────────────────────────────────────── */

const failures = new Map()

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress ?? ''
}

function throttled(ip) {
  const entry = failures.get(ip)
  if (!entry) return false
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) { failures.delete(ip); return false }
  return entry.count >= MAX_LOGIN_FAILURES
}

function noteFailure(ip) {
  const entry = failures.get(ip)
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 })
  else entry.count += 1
}

/* ── dsh instance pool ───────────────────────────────────────────────────── */

/** A filesystem-safe, human-readable directory name that cannot collide. */
function userSlug(key, label) {
  const base = String(label || '').trim().replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/^-+|-+$/gu, '')
  return base ? `${base}-${key.slice(-5)}` : key
}

const usedPorts = new Set()
const instances = new Map()
const starting = new Map()

function allocatePort() {
  for (let candidate = PORT_BASE + 1; candidate < PORT_BASE + 500; candidate += 1) {
    if (!usedPorts.has(candidate)) { usedPorts.add(candidate); return candidate }
  }
  throw new Error('no free instance port available')
}

class DshInstance {
  constructor(key, label) {
    this.key = key
    this.slug = userSlug(key, label)
    this.dir = path.join(USERS_ROOT, this.slug)
    this.home = path.join(this.dir, 'dsh-home')
    this.workspace = path.join(WORKSPACE_ROOT, this.slug)
    this.logFile = path.join(LOG_DIR, `dsh-${this.slug}.log`)
    this.port = null
    this.child = null
    this.cookie = null
    this.cookieAt = 0
    this.lastUsed = Date.now()
    this.ready = false
  }

  get authority() { return `127.0.0.1:${String(this.port)}` }

  async start() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.workspace, { recursive: true })
    fs.mkdirSync(path.join(this.dir, 'home'), { recursive: true })
    this.port = allocatePort()

    // Per-user configuration is rendered from the same environment variables
    // the container was given, just pointed at this user's DSH_HOME.
    await runConfigRenderer(this.home)

    const args = [DSH_BIN, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(this.port)]
    for (const overlay of overlays) args.push('--patch', overlay)

    const out = fs.openSync(this.logFile, 'a')
    fs.writeSync(out, `\n--- instance start ${new Date().toISOString()} (${this.authority}) ---\n`)
    this.child = spawn(process.execPath, args, {
      cwd: this.workspace,
      env: {
        ...process.env,
        DSH_HOME: this.home,
        HOME: path.join(this.dir, 'home'),
        DSH_TELEMETRY_DISABLED: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', out, out],
      detached: false,
    })
    fs.closeSync(out)

    this.child.on('exit', (code) => {
      process.stdout.write(`[gateway] instance ${this.slug} exited (${String(code)})\n`)
      this.ready = false
      this.child = null
      if (instances.get(this.key) === this) instances.delete(this.key)
      usedPorts.delete(this.port)
      writeInstanceState()
    })

    const deadline = Date.now() + BOOT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.child === null) throw new Error(`instance ${this.slug} exited during startup`)
      try {
        await this.ensureCookie(true)
        this.ready = true
        process.stdout.write(`[gateway] instance ready for ${this.slug} on ${this.authority}\n`)
        // The snapshot is written by the caller, after this instance is in the
        // map — writing here would record an empty list.
        return this
      } catch {
        await sleep(700)
      }
    }
    this.stop()
    throw new Error(`instance ${this.slug} did not become ready within ${String(BOOT_TIMEOUT_MS / 1000)}s`)
  }

  /** Recover the one-shot launch token from this instance's own log. */
  readLaunchToken() {
    let text
    try { text = fs.readFileSync(this.logFile, 'utf8') } catch { return undefined }
    const matches = [...text.matchAll(/\?token=([A-Za-z0-9_-]{16,})/gu)]
    return matches.length > 0 ? matches[matches.length - 1][1] : undefined
  }

  async ensureCookie(force = false) {
    if (!force && this.cookie && Date.now() - this.cookieAt < 6 * 60 * 60 * 1000) return this.cookie
    const token = this.readLaunchToken()
    if (!token) throw new Error('launch token not present yet')
    const response = await fetch(`http://${this.authority}/?token=${token}`, {
      redirect: 'manual',
      headers: { host: this.authority },
    })
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
    const cookie = raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ')
    if (!cookie) throw new Error(`token exchange returned no cookie (HTTP ${String(response.status)})`)
    this.cookie = cookie
    this.cookieAt = Date.now()
    return cookie
  }

  touch() { this.lastUsed = Date.now() }

  stop() {
    if (this.child) { try { this.child.kill('SIGTERM') } catch { /* already gone */ } }
    if (this.port !== null) usedPorts.delete(this.port)
    this.ready = false
  }
}

function runConfigRenderer(home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['/app/auth/render-config.mjs'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`render-config failed (${String(code)}): ${stderr.trim()}`))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Boots are run one at a time. Two colleagues logging in at once would
 * otherwise cold-start two dsh processes concurrently; measured on a fresh
 * container that contention stretched a boot past two minutes, whereas a
 * serialised boot is ~7s once the first one has warmed the page cache.
 */
let startChain = Promise.resolve()
function serializeStart(task) {
  const queued = startChain.then(task, task)
  startChain = queued.then(() => undefined, () => undefined)
  return queued
}

/** Resolve this licence's instance, starting one if needed. Concurrent callers share one start. */
function ensureInstance(key) {
  const existing = instances.get(key)
  if (existing?.ready) { existing.touch(); return Promise.resolve(existing) }
  const inFlight = starting.get(key)
  if (inFlight) return inFlight
  if (instances.size + starting.size >= MAX_INSTANCES) {
    return Promise.reject(new Error(`instance limit reached (${String(MAX_INSTANCES)}); try again shortly`))
  }
  const row = db.prepare('SELECT label FROM licenses WHERE key = ?').get(key)
  const instance = new DshInstance(key, row?.label ?? '')
  const task = serializeStart(() => instance.start())
    .then((i) => {
      starting.delete(key)
      instances.set(key, i)
      writeInstanceState()
      return i
    })
    .catch((error) => { starting.delete(key); instance.stop(); writeInstanceState(); throw error })
  starting.set(key, task)
  return task
}

async function stopInstance(key) {
  const instance = instances.get(key) ?? (await starting.get(key)?.catch(() => undefined))
  if (instance) { instance.stop(); instances.delete(key); usedPorts.delete(instance.port); writeInstanceState() }
}

function writeInstanceState() {
  const state = [...instances.values()].map((i) => ({
    licence: i.key, label: i.slug, port: i.port, pid: i.child?.pid ?? null,
    ready: i.ready, idleSeconds: Math.round((Date.now() - i.lastUsed) / 1000),
    workspace: i.workspace, home: i.home,
  }))
  try { fs.writeFileSync('/data/instances.json', JSON.stringify(state, null, 2)) } catch { /* best effort */ }
}

/* Optional operator-supplied cordis overlays, applied to every instance. */
const overlays = []
if (fs.existsSync('/data/overlays')) {
  for (const name of fs.readdirSync('/data/overlays').sort()) {
    if (/\.ya?ml$/u.test(name)) overlays.push(path.join('/data/overlays', name))
  }
}

/* ── pages ───────────────────────────────────────────────────────────────── */

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#111418; color:#e6e8eb;
         font:15px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  .card { width:min(92vw,400px); background:#191d23; border:1px solid #262c35;
          border-radius:14px; padding:32px 28px; box-shadow:0 18px 48px rgba(0,0,0,.45); }
  h1 { margin:0 0 6px; font-size:19px; font-weight:600; letter-spacing:.2px; }
  p.sub { margin:0 0 24px; color:#8b949e; font-size:13px; }
  label { display:block; font-size:13px; color:#8b949e; margin-bottom:8px; }
  input { width:100%; padding:11px 13px; border-radius:9px; border:1px solid #30363d;
          background:#0d1117; color:#e6e8eb; font-size:15px; letter-spacing:1px;
          font-family:ui-monospace,SFMono-Regular,Consolas,monospace; outline:none; }
  input:focus { border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,.18); }
  button { width:100%; margin-top:18px; padding:11px; border:0; border-radius:9px;
           background:#2f6feb; color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { background:#3b7ff0; }
  .err { margin-top:16px; padding:10px 12px; border-radius:8px; font-size:13px;
         background:rgba(248,81,73,.12); border:1px solid rgba(248,81,73,.35); color:#ff9d97; }
  .foot { margin-top:22px; padding-top:16px; border-top:1px solid #262c35;
          color:#6e7681; font-size:12px; text-align:center; }
  .spin { width:26px; height:26px; margin:4px auto 18px; border:3px solid #262c35;
          border-top-color:#2f6feb; border-radius:50%; animation:r 1s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
`

const escapeHtml = (value) => String(value).replace(/[&<>"']/gu, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

function loginPage({ error, next } = {}) {
  const message = {
    invalid: '授权码格式不正确。',
    unknown: '授权码不存在，请联系管理员。',
    revoked: '该授权码已被吊销。',
    expired: '该授权码已过期。',
    toomany: '该授权码已达并发设备上限。',
    throttled: '尝试次数过多，请 5 分钟后再试。',
    capacity: '当前使用人数已达上限，请稍后再试。',
  }[error]

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness · 授权访问</title><style>${PAGE_STYLE}</style></head>
<body><form class="card" method="POST" action="/__auth/login">
  <h1>DeepSeek Harness</h1>
  <p class="sub">请输入管理员分配的授权码以继续</p>
  <label for="key">授权码</label>
  <input id="key" name="key" autocomplete="off" autofocus
         placeholder="DSH-XXXX-XXXX-XXXX-XXXX" spellcheck="false">
  <input type="hidden" name="next" value="${next ? escapeHtml(next) : '/'}">
  <button type="submit">进入</button>
  ${message ? `<div class="err">${escapeHtml(message)}</div>` : ''}
  <div class="foot">内网离线部署 · 访问行为将被记录</div>
</form></body></html>`
}

function bootingPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在准备工作环境</title><style>${PAGE_STYLE}</style>
<meta http-equiv="refresh" content="3"></head>
<body><div class="card" style="text-align:center">
  <div class="spin"></div>
  <h1>正在准备工作环境</h1>
  <p class="sub">首次进入需要启动你的专属实例，约需 10 秒。</p>
  <div class="foot">页面会自动刷新</div>
</div></body></html>`
}

function errorPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(detail)}</p>
<div class="foot">请联系管理员并提供容器日志</div></div></body></html>`
}

function safeNext(value) {
  const candidate = String(value ?? '/')
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/'
  return candidate
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/* ── proxy ───────────────────────────────────────────────────────────────── */

/**
 * Rewrite every request onto the instance's loopback authority. dsh binds its
 * authentication cookie to the Host authority and fences /api on Host/Origin,
 * so both must agree with the authority the cookie was minted for.
 */
function buildUpstreamHeaders(req, instance) {
  const headers = { ...req.headers }
  headers.host = instance.authority
  if (headers.origin !== undefined) headers.origin = `http://${instance.authority}`
  if (typeof headers.referer === 'string') {
    headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/u, `http://${instance.authority}`)
  }
  headers.cookie = instance.cookie ?? ''
  headers['x-forwarded-for'] = clientIp(req)
  headers['x-forwarded-proto'] = 'http'
  return headers
}

function proxy(req, res, instance, { retried = false } = {}) {
  const upstream = http.request({
    host: '127.0.0.1',
    port: instance.port,
    method: req.method,
    path: req.url,
    headers: buildUpstreamHeaders(req, instance),
  }, (upRes) => {
    if (upRes.statusCode === 401 && !retried) {
      upRes.resume()
      instance.ensureCookie(true)
        .then(() => proxy(req, res, instance, { retried: true }))
        .catch(() => sendUnavailable(res))
      return
    }
    const headers = { ...upRes.headers }
    // dsh's cookies belong to the gateway, never to the browser.
    delete headers['set-cookie']
    delete headers.connection
    delete headers['keep-alive']
    delete headers['transfer-encoding']
    res.writeHead(upRes.statusCode ?? 502, headers)
    upRes.pipe(res)
  })

  upstream.on('error', () => { if (!res.headersSent) sendUnavailable(res) })
  req.pipe(upstream)
}

function sendUnavailable(res) {
  if (res.headersSent) { res.end(); return }
  send(res, 503, bootingPage())
}

/* ── routing ─────────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://gateway.invalid')

  if (url.pathname === '/__auth/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      gateway: 'ok',
      auth: AUTH_DISABLED ? 'disabled' : 'enabled',
      instances: [...instances.values()].map((i) => ({ licence: i.slug, ready: i.ready })),
      starting: starting.size,
    }))
    return
  }

  if (url.pathname === '/__auth/login' && req.method === 'GET') {
    send(res, 200, loginPage({ error: url.searchParams.get('e'), next: safeNext(url.searchParams.get('next')) }))
    return
  }

  if (url.pathname === '/__auth/login' && req.method === 'POST') {
    const ip = clientIp(req)
    if (throttled(ip)) { send(res, 429, loginPage({ error: 'throttled' })); return }

    const body = new URLSearchParams(await readBody(req).catch(() => ''))
    const verdict = checkLicense(db, body.get('key') ?? '')
    if (!verdict.ok) {
      noteFailure(ip)
      audit(db, 'login_failed', { ip, detail: verdict.reason })
      send(res, 401, loginPage({ error: verdict.reason, next: safeNext(body.get('next')) }))
      return
    }

    const maxDevices = Number(db.prepare('SELECT max_devices FROM licenses WHERE key = ?').get(verdict.key)?.max_devices ?? 0)
    if (maxDevices > 0 && activeSessionCount(db, verdict.key) >= maxDevices) {
      audit(db, 'login_rejected_devices', { licenseKey: verdict.key, ip })
      send(res, 403, loginPage({ error: 'toomany' }))
      return
    }

    const sessionId = createSession(db, verdict.key, {
      ip, userAgent: req.headers['user-agent'], ttlSeconds: SESSION_TTL_SECONDS,
    })
    audit(db, 'login_ok', { licenseKey: verdict.key, ip })
    failures.delete(ip)
    issueCookie(res, sessionId)

    // Warm this licence's instance while the browser follows the redirect, so
    // the first page load usually lands on a ready instance.
    void ensureInstance(verdict.key).catch((error) => {
      process.stderr.write(`[gateway] instance start failed for ${verdict.key}: ${error.message}\n`)
    })

    send(res, 303, '', { location: safeNext(body.get('next')), 'content-type': 'text/plain' })
    return
  }

  if (url.pathname === '/__auth/logout') {
    const session = authenticate(req)
    if (session) {
      dropSession(db, session.id)
      audit(db, 'logout', { licenseKey: session.license_key, ip: clientIp(req) })
    }
    clearCookie(res)
    send(res, 303, '', { location: '/__auth/login', 'content-type': 'text/plain' })
    return
  }

  const session = authenticate(req)
  if (!session) {
    if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
      send(res, 303, '', {
        location: `/__auth/login?next=${encodeURIComponent(safeNext(req.url))}`,
        'content-type': 'text/plain',
      })
      return
    }
    send(res, 401, '未授权：请先登录。\n', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }

  let instance
  try {
    instance = await ensureInstance(session.license_key)
  } catch (error) {
    const capacity = error.message.includes('limit reached')
    audit(db, 'instance_unavailable', { licenseKey: session.license_key, ip: clientIp(req), detail: error.message })
    process.stderr.write(`[gateway] ${error.message}\n`)
    send(res, capacity ? 503 : 500, errorPage(
      capacity ? '当前使用人数已达上限' : '工作环境启动失败',
      capacity ? '请稍后重试，或联系管理员调整实例上限。' : error.message,
    ))
    return
  }

  instance.touch()
  proxy(req, res, instance)
})

/* ── websocket / upgrade passthrough ─────────────────────────────────────── */

server.on('upgrade', async (req, socket, head) => {
  const session = authenticate(req)
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  let instance
  try {
    instance = await ensureInstance(session.license_key)
  } catch {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  instance.touch()

  const upstream = net.connect(instance.port, '127.0.0.1', () => {
    const headers = buildUpstreamHeaders(req, instance)
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })

  const teardown = () => { upstream.destroy(); socket.destroy() }
  upstream.on('error', teardown)
  socket.on('error', teardown)
})

/* ── maintenance ─────────────────────────────────────────────────────────── */

setInterval(() => {
  try {
    const purged = purgeExpiredSessions(db)
    if (purged > 0) process.stdout.write(`[gateway] purged ${String(purged)} expired sessions\n`)
  } catch { /* ignore */ }

  for (const [key, instance] of instances) {
    // A licence can lapse without any request arriving to notice it: revoking
    // deletes the session rows outright, so the request path never runs. Sweep
    // here, otherwise a revoked user's instance lives until the idle timeout.
    if (!AUTH_DISABLED && key !== ANONYMOUS_KEY) {
      const verdict = checkLicense(db, key)
      if (!verdict.ok) {
        process.stdout.write(`[gateway] stopping instance ${instance.slug}: licence ${verdict.reason}\n`)
        audit(db, 'instance_stopped', { licenseKey: key, detail: `licence ${verdict.reason}` })
        instance.stop()
        instances.delete(key)
        usedPorts.delete(instance.port)
        continue
      }
    }
    if (Date.now() - instance.lastUsed > IDLE_REAP_MS) {
      process.stdout.write(`[gateway] reclaiming idle instance ${instance.slug}\n`)
      audit(db, 'instance_reaped', { licenseKey: key, detail: `idle ${String(Math.round(IDLE_REAP_MS / 60000))}m` })
      instance.stop()
      instances.delete(key)
      usedPorts.delete(instance.port)
    }
  }
  writeInstanceState()
}, 60 * 1000).unref()

server.listen(PORT, BIND, () => {
  process.stdout.write(`[gateway] listening on http://${BIND}:${String(PORT)}\n`)
  process.stdout.write(`[gateway] licence database: ${DB_PATH}\n`)
  process.stdout.write(`[gateway] per-licence instances: ports ${String(PORT_BASE + 1)}+, max ${String(MAX_INSTANCES)}, idle reclaim ${String(Math.round(IDLE_REAP_MS / 60000))}m\n`)
  process.stdout.write(`[gateway] authentication: ${AUTH_DISABLED ? 'DISABLED' : 'enabled'}\n`)
})

function shutdown() {
  process.stdout.write('[gateway] shutting down instances\n')
  for (const instance of instances.values()) instance.stop()
  server.close(() => { try { db.close() } catch { /* ignore */ } process.exit(0) })
  setTimeout(() => process.exit(0), 5000).unref()
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown)
