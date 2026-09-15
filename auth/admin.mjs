#!/usr/bin/env node
/**
 * License administration CLI.
 *
 * Runs against the same SQLite file the gateway uses, so it can be executed
 * from the host while the container is running:
 *
 *   docker exec -it dsh dsh-license add --label "张三" --days 365
 *   docker exec -it dsh dsh-license list
 *   docker exec -it dsh dsh-license revoke DSH-XXXX-XXXX-XXXX-XXXX
 */
import {
  openDb, migrate, generateKey, normalizeKey, formatKey,
  checkLicense, nowSec,
} from './lib.mjs'

const DB_PATH = process.env.GATEWAY_DB ?? '/data/auth.db'

function usage(code = 0) {
  const text = `
dsh-license — 授权码管理

用法:
  dsh-license add [--label <备注>] [--days <N>] [--max-devices <N>] [--key <KEY>]
  dsh-license list
  dsh-license show <KEY>
  dsh-license revoke <KEY>
  dsh-license restore <KEY>
  dsh-license remove <KEY>
  dsh-license sessions [--all]
  dsh-license kick <KEY|SESSION_ID>
  dsh-license audit [--limit N]

说明:
  --days 0 或省略表示永不过期；--max-devices 0 表示不限制并发设备数。
`
  process.stdout.write(text)
  process.exit(code)
}

function parseFlags(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[name] = true
      else { flags[name] = next; i += 1 }
    } else rest.push(token)
  }
  return { flags, rest }
}

function table(rows, columns) {
  if (rows.length === 0) return '(空)'
  const widths = columns.map((c) => Math.max(
    c.title.length,
    ...rows.map((r) => String(c.get(r) ?? '').length),
  ))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  return [
    line(columns.map((c) => c.title)),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(columns.map((c) => c.get(r) ?? ''))),
  ].join('\n')
}

const fmtTime = (sec) => (sec ? new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) : '—')

const db = openDb(DB_PATH)
migrate(db)

const [command, ...argv] = process.argv.slice(2)
const { flags, rest } = parseFlags(argv)

switch (command) {
  case 'add': {
    const key = normalizeKey(flags.key) || generateKey()
    if (db.prepare('SELECT 1 FROM licenses WHERE key = ?').get(key)) {
      process.stderr.write(`授权码已存在: ${formatKey(key)}\n`)
      process.exit(1)
    }
    const days = Number(flags.days ?? 0)
    const maxDevices = Number(flags['max-devices'] ?? 0)
    const expiresAt = days > 0 ? nowSec() + days * 86400 : null
    db.prepare(`INSERT INTO licenses (key, label, note, created_at, expires_at, revoked, max_devices)
                VALUES (?, ?, ?, ?, ?, 0, ?)`)
      .run(key, String(flags.label ?? ''), String(flags.note ?? ''), nowSec(), expiresAt, maxDevices)
    process.stdout.write(`已创建授权码: ${formatKey(key)}\n`)
    if (flags.label) process.stdout.write(`  备注: ${flags.label}\n`)
    process.stdout.write(`  有效期: ${expiresAt ? fmtTime(expiresAt) : '永久'}\n`)
    process.stdout.write(`  并发上限: ${maxDevices > 0 ? maxDevices : '不限'}\n`)
    break
  }

  case 'list': {
    const rows = db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all()
    process.stdout.write(`${table(rows.map((r) => ({
      ...r,
      display: formatKey(r.key),
      status: r.revoked ? '已吊销' : (r.expires_at !== null && r.expires_at <= nowSec() ? '已过期' : '有效'),
      expires: fmtTime(r.expires_at),
      used: fmtTime(r.last_used_at),
    })), [
      { title: '授权码', get: (r) => r.display },
      { title: '状态', get: (r) => r.status },
      { title: '备注', get: (r) => r.label },
      { title: '到期', get: (r) => r.expires },
      { title: '最后使用', get: (r) => r.used },
    ])}\n`)
    break
  }

  case 'show': {
    const verdict = checkLicense(db, rest[0] ?? '')
    if (!verdict.ok) { process.stdout.write(`无效: ${verdict.reason}\n`); break }
    const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(verdict.key)
    process.stdout.write(`${JSON.stringify(row, null, 2)}\n`)
    break
  }

  case 'revoke': {
    const key = normalizeKey(rest[0] ?? '')
    const info = db.prepare('UPDATE licenses SET revoked = 1 WHERE key = ?').run(key)
    if (info.changes === 0) { process.stderr.write('未找到该授权码\n'); process.exit(1) }
    const killed = db.prepare('DELETE FROM sessions WHERE license_key = ?').run(key).changes
    process.stdout.write(`已吊销 ${formatKey(key)}，并断开 ${killed} 个会话\n`)
    break
  }

  case 'restore': {
    const key = normalizeKey(rest[0] ?? '')
    const info = db.prepare('UPDATE licenses SET revoked = 0 WHERE key = ?').run(key)
    if (info.changes === 0) { process.stderr.write('未找到该授权码\n'); process.exit(1) }
    process.stdout.write(`已恢复 ${formatKey(key)}\n`)
    break
  }

  case 'remove': {
    const key = normalizeKey(rest[0] ?? '')
    db.prepare('DELETE FROM sessions WHERE license_key = ?').run(key)
    const info = db.prepare('DELETE FROM licenses WHERE key = ?').run(key)
    if (info.changes === 0) { process.stderr.write('未找到该授权码\n'); process.exit(1) }
    process.stdout.write(`已删除 ${formatKey(key)}\n`)
    break
  }

  case 'sessions': {
    const onlyLive = !flags.all
    const rows = onlyLive
      ? db.prepare('SELECT * FROM sessions WHERE expires_at > ? ORDER BY last_seen_at DESC').all(nowSec())
      : db.prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC').all()
    process.stdout.write(`${table(rows.map((r) => ({ ...r, key: formatKey(r.license_key) })), [
      { title: '会话ID', get: (r) => r.id.slice(0, 12) },
      { title: '授权码', get: (r) => r.key },
      { title: '来源IP', get: (r) => r.ip },
      { title: '最后活动', get: (r) => fmtTime(r.last_seen_at) },
      { title: '到期', get: (r) => fmtTime(r.expires_at) },
    ])}\n`)
    break
  }

  case 'kick': {
    const target = normalizeKey(rest[0] ?? '')
    let killed
    if (target.length >= 8) {
      killed = db.prepare('DELETE FROM sessions WHERE license_key = ?').run(target).changes
    } else {
      killed = db.prepare('DELETE FROM sessions WHERE id LIKE ?').run(`${rest[0]}%`).changes
    }
    process.stdout.write(`已断开 ${killed} 个会话\n`)
    break
  }

  case 'audit': {
    const limit = Number(flags.limit ?? 50)
    const rows = db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT ?').all(limit)
    process.stdout.write(`${table(rows.map((r) => ({
      ...r,
      when: fmtTime(r.at),
      key: r.license_key ? formatKey(r.license_key) : '—',
    })), [
      { title: '时间', get: (r) => r.when },
      { title: '事件', get: (r) => r.event },
      { title: '授权码', get: (r) => r.key },
      { title: 'IP', get: (r) => r.ip },
      { title: '详情', get: (r) => r.detail },
    ])}\n`)
    break
  }

  case 'export': {
    const rows = db.prepare('SELECT * FROM licenses ORDER BY created_at').all()
    process.stdout.write(`${rows.map((r) => formatKey(r.key)).join('\n')}\n`)
    break
  }

  default:
    usage(command === undefined || command === 'help' || command === '--help' ? 0 : 1)
}

db.close()
