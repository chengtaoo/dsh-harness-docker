#!/usr/bin/env node
/**
 * 诊断用透明代理：把 dsh 发给模型服务的请求原样记录下来。
 *
 * dsh 是直连模型服务的，网关看不到这些请求，所以排查「某个预设报 422」
 * 这类问题时，只能让 dsh 先经过一个会记录的中转。
 *
 * 用法（在容器内执行）：
 *
 *   docker exec -d dsh node /app/auth/capture-proxy.mjs \
 *     --target http://15.124.235.210:1025 --port 1080
 *
 * 然后把 .env 里的地址临时改掉并重启：
 *
 *   DSH_LLM_BASE_URL=http://127.0.0.1:1080/v1
 *
 * 复现问题后，抓到的请求会按时间顺序写在 /data/logs/captured/ 下。
 * 排查完记得把地址改回来并停掉本进程。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const TARGET = arg('target')
const PORT = Number(arg('port', '1080'))
const OUT = arg('out', '/data/logs/captured')
const REF = arg('label', '')

if (!TARGET) {
  process.stderr.write('用法: capture-proxy.mjs --target <模型服务地址> [--port 1080] [--out 目录] [--label 标记]\n')
  process.exit(2)
}

const target = new URL(TARGET)
fs.mkdirSync(OUT, { recursive: true })

let seq = 0

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)

    // Record before forwarding, so a rejection still leaves evidence behind.
    seq += 1
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const base = path.join(OUT, `${String(seq).padStart(3, '0')}-${stamp}${REF ? `-${REF}` : ''}`)
    try {
      fs.writeFileSync(`${base}.json`, body)
      fs.writeFileSync(`${base}.meta.json`, JSON.stringify({
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, k === 'authorization' ? '[redacted]' : v]),
        ),
      }, null, 2))
    } catch (error) {
      process.stderr.write(`[capture] 写入失败: ${error.message}\n`)
    }

    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    }, (upRes) => {
      const parts = []
      upRes.on('data', (c) => parts.push(c))
      upRes.on('end', () => {
        const reply = Buffer.concat(parts)
        if (upRes.statusCode !== 200) {
          process.stdout.write(`[capture] #${String(seq)} ${String(upRes.statusCode)} ${req.url}\n`)
          try { fs.writeFileSync(`${base}.response.txt`, reply) } catch { /* best effort */ }
        }
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        res.end(reply)
      })
    })

    upstream.on('error', (error) => {
      process.stderr.write(`[capture] 上游错误: ${error.message}\n`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`capture proxy: upstream error: ${error.message}\n`)
    })

    upstream.end(body)
  })
})

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[capture] 监听 :${String(PORT)} → ${TARGET}\n`)
  process.stdout.write(`[capture] 记录到 ${OUT}\n`)
})
