/**
 * Acceptance probe: exercises login, HTTP proxy, the /api trust fence and the
 * WebSocket mux for one licence, printing PASS/FAIL per check.
 *
 *   node accept.mjs <gatewayPort> <licenceKey> <label>
 */
import net from 'node:net'
import crypto from 'node:crypto'

const PORT = Number(process.argv[2] ?? 8080)
const KEY = process.argv[3]
const LABEL = process.argv[4] ?? 'user'
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${LABEL}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ── 1. unauthenticated access is refused ────────────────────────────────── */
const anon = await fetch(`${BASE}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
check('未登录访问被拦截', anon.status === 303 && anon.headers.get('location')?.includes('/__auth/login'),
  `HTTP ${anon.status}`)

/* ── 2. login ────────────────────────────────────────────────────────────── */
const login = await fetch(`${BASE}/__auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: `key=${encodeURIComponent(KEY)}`,
  redirect: 'manual',
})
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
check('授权码登录成功', login.status === 303 && cookie.length > 0, `HTTP ${login.status}`)

/* ── 3. wait for this licence's instance ─────────────────────────────────── */
let ready = false
let seen = ''
for (let i = 0; i < 40; i += 1) {
  const h = await (await fetch(`${BASE}/__auth/healthz`)).json()
  seen = JSON.stringify(h.instances)
  // Wait for THIS licence's instance specifically, not merely any instance.
  if (h.instances?.some((x) => x.licence.startsWith(LABEL) && x.ready)) { ready = true; break }
  await new Promise((r) => setTimeout(r, 3000))
}
check('专属实例已就绪', ready, seen)

/* ── 4. web UI is served ─────────────────────────────────────────────────── */
const page = await fetch(`${BASE}/`, { headers: { cookie } })
const html = await page.text()
check('Web UI 正常返回', page.status === 200 && html.includes('__ModuleLoader__'), `HTTP ${page.status}, ${html.length}B`)

/* ── 5. /api passes the Host/Origin trust fence ──────────────────────────── */
const api = await fetch(`${BASE}/api/session/list`, {
  method: 'POST',
  headers: {
    cookie,
    'content-type': 'application/json',
    origin: BASE,
    'sec-fetch-site': 'same-origin',
  },
  body: '{}',
})
const apiBody = await api.text()
check(' /api 通过信任围栏', api.status !== 403 && api.status !== 401,
  `HTTP ${api.status} ${apiBody.slice(0, 60)}`)

/* ── 6. WebSocket mux ────────────────────────────────────────────────────── */
function wsHandshake(sendCookie) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64')
    const expected = crypto.createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    const socket = net.connect(PORT, HOST, () => {
      const lines = [
        'GET /api/remote.mux HTTP/1.1',
        `Host: ${HOST}:${PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Origin: ${BASE}`,
        'Sec-Fetch-Site: same-origin',
      ]
      if (sendCookie) lines.push(`Cookie: ${sendCookie}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1')
      if (!buf.includes('\r\n\r\n')) return
      const status = buf.split('\r\n')[0]
      const accept = /sec-websocket-accept:\s*(\S+)/iu.exec(buf)?.[1]
      socket.destroy()
      resolve({ status, ok: status.includes('101') && accept === expected })
    })
    socket.on('error', (e) => resolve({ status: `ERROR ${e.message}`, ok: false }))
    setTimeout(() => { socket.destroy(); resolve({ status: 'TIMEOUT', ok: false }) }, 8000)
  })
}

const wsAnon = await wsHandshake(null)
check('未授权 WebSocket 被拒', !wsAnon.ok && wsAnon.status.includes('401'), wsAnon.status)

const wsAuth = await wsHandshake(cookie)
check('授权 WebSocket 建立成功', wsAuth.ok, wsAuth.status)

console.log(`\n[${LABEL}] ${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
