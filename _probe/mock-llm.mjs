/**
 * Minimal OpenAI-compatible endpoint, used only to exercise the image's
 * end-to-end path without an intranet GPU server present.
 *
 *   node mock-llm.mjs [port]
 */
import http from 'node:http'

const PORT = Number(process.argv[2] ?? 11434)

const server = http.createServer((req, res) => {
  process.stdout.write(`[mock-llm] ${req.method} ${req.url}\n`)

  if (req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'mock' }],
    }))
    return
  }

  if (req.url?.startsWith('/v1/chat/completions')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let wantsStream = true
      try { wantsStream = JSON.parse(body).stream !== false } catch { /* default */ }
      const id = `chatcmpl-mock-${Date.now()}`
      const created = Math.floor(Date.now() / 1000)

      if (!wantsStream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id, object: 'chat.completion', created, model: 'deepseek-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (delta, finish = null) => {
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: 'deepseek-chat',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`)
      }
      send({ role: 'assistant', content: 'MOCK_OK' })
      send({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'not found' } }))
})

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[mock-llm] listening on http://0.0.0.0:${PORT}/v1\n`)
})
