/**
 * Shared license store for the dsh auth gateway.
 *
 * Backed by node:sqlite (built into Node 22.13+/24) so the image needs no
 * native module compilation and no external database service.
 *
 * The license key is stored in its *stripped* canonical form (uppercase, no
 * separators) so that a user may type it with or without dashes.
 */
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const nowMs = () => Date.now()
export const nowSec = () => Math.floor(Date.now() / 1000)

/* Unambiguous alphabet: no 0/O/1/I/L, so keys survive being read aloud. */
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const KEY_PREFIX = 'DSH'
const KEY_GROUPS = 4
const KEY_GROUP_LEN = 4

/**
 * Storage form carries the prefix itself, so the string an administrator
 * copies off the screen normalizes back to exactly the stored value.
 * Stripping a prefix at lookup time instead would be ambiguous: the alphabet
 * contains D, S and H, so a legitimate key could begin with "DSH".
 */
export function generateKey() {
  const bytes = crypto.randomBytes(KEY_GROUPS * KEY_GROUP_LEN)
  const chars = []
  for (let i = 0; i < bytes.length; i += 1) chars.push(KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length])
  return KEY_PREFIX + chars.join('')
}

/** Canonical form: uppercase, separators removed. */
export function normalizeKey(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/gu, '')
}

/** Human-facing form: DSH-XXXX-XXXX-XXXX-XXXX */
export function formatKey(stored) {
  const body = stored.startsWith(KEY_PREFIX) ? stored.slice(KEY_PREFIX.length) : stored
  const groups = body.match(/.{1,4}/gu) ?? [body]
  return `${KEY_PREFIX}-${groups.join('-')}`
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS licenses (
      key         TEXT PRIMARY KEY,
      label       TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER,
      revoked     INTEGER NOT NULL DEFAULT 0,
      max_devices INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      license_key TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip          TEXT NOT NULL DEFAULT '',
      user_agent  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS sessions_license ON sessions (license_key);

    CREATE TABLE IF NOT EXISTS audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      event       TEXT NOT NULL,
      license_key TEXT,
      ip          TEXT,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
  `)
}

export function getMeta(db, k) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k)
  return row ? row.v : undefined
}

export function setMeta(db, k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v)
}

/** Stable HMAC secret for gateway cookies; generated once per database. */
export function cookieSecret(db) {
  const existing = getMeta(db, 'cookie_secret')
  if (existing) return Buffer.from(existing, 'hex')
  const created = crypto.randomBytes(32)
  setMeta(db, 'cookie_secret', created.toString('hex'))
  return created
}

export function audit(db, event, { licenseKey = null, ip = null, detail = null } = {}) {
  db.prepare('INSERT INTO audit (at, event, license_key, ip, detail) VALUES (?, ?, ?, ?, ?)')
    .run(nowSec(), event, licenseKey, ip, detail)
}

/**
 * Look up a license and decide whether it may be used right now.
 * @returns {{ok: true, key: string, label: string, expiresAt: number|null}
 *          | {ok: false, reason: string}}
 */
export function checkLicense(db, rawKey) {
  const key = normalizeKey(rawKey)
  if (key.length < 8) return { ok: false, reason: 'invalid' }
  // Every stored key carries the prefix, so re-trying with it added is
  // unambiguous and forgives an operator who typed only the body.
  const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key)
    ?? (key.startsWith(KEY_PREFIX) ? undefined : db.prepare('SELECT * FROM licenses WHERE key = ?').get(KEY_PREFIX + key))
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.revoked) return { ok: false, reason: 'revoked' }
  if (row.expires_at !== null && row.expires_at <= nowSec()) return { ok: false, reason: 'expired' }
  // Report the stored spelling, never the typed one: session rows are keyed by it.
  return { ok: true, key: row.key, label: row.label, expiresAt: row.expires_at }
}

/** Count live sessions bound to a license (used for the max_devices cap). */
export function activeSessionCount(db, key) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE license_key = ? AND expires_at > ?')
    .get(key, nowSec())
  return row ? Number(row.n) : 0
}

export function createSession(db, key, { ip, userAgent, ttlSeconds }) {
  const id = crypto.randomBytes(24).toString('base64url')
  const ts = nowSec()
  db.prepare(`INSERT INTO sessions (id, license_key, created_at, expires_at, last_seen_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, key, ts, ts + ttlSeconds, ts, ip ?? '', String(userAgent ?? '').slice(0, 400))
  db.prepare('UPDATE licenses SET last_used_at = ? WHERE key = ?').run(ts, key)
  return id
}

export function getSession(db, id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
  if (!row) return undefined
  if (row.expires_at <= nowSec()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return undefined
  }
  return row
}

export function touchSession(db, id) {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowSec(), id)
}

export function slideSession(db, id, ttlSeconds) {
  db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
    .run(nowSec() + ttlSeconds, nowSec(), id)
}

export function dropSession(db, id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function purgeExpiredSessions(db) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowSec()).changes
}
