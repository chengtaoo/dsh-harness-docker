/**
 * OpenAI-compatible mock that RECORDS the exact request dsh sends, so we can
 * see which fields and values reach the model server.
 *
 *   node mock-llm-capture.mjs [port] [outfile]
 */
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.argv[2] ?? 11434)
const OUT = process.argv[3] ?? 'C:/tmp/dsh-request.json'
let biggest = 0

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'Qwen3-235B-W8A8', object: 'model', owned_by: 'mock' }],
    }))
    return
  }

  if (req.url?.startsWith('/v1/chat/completions')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const record = { url: req.url, method: req.method, headers: {}, body: null }
      for (const [k, v] of Object.entries(req.headers)) {
        // keep the shape, redact the secret
        record.headers[k] = k === 'authorization' ? String(v).slice(0, 12) + '...' : v
      }
      try { record.body = JSON.parse(body) } catch { record.body = body }
      record.raw = body
      // Append every request: a session makes several, and the interesting one
      // (the main agent turn) is not necessarily the last.
      let all = []
      try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')) } catch { /* first write */ }
      all.push(record)
      fs.writeFileSync(OUT, JSON.stringify(all, null, 2))

      // Keep the biggest request verbatim: replaying it against the real
      // endpoint reproduces the failure exactly, which is what bisection needs.
      if (body.length > biggest) {
        biggest = body.length
        fs.writeFileSync(`${OUT}.replay.json`, body)
      }

      // Answer in a way that lets dsh finish its turn, so we capture the real
      // request rather than a retry.
      const id = 'chatcmpl-mock'
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: 1, model: 'Qwen3-235B-W8A8',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`)
      chunk({ role: 'assistant', content: 'MOCK_OK' })
      chunk({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[capture] listening on ${PORT}, writing request to ${OUT}\n`)
})
