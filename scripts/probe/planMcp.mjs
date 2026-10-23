// probe16 용 MCP — approve 만. ExitPlanMode 첫 번째는 의견을 붙여 거절, 두 번째부터 허용. 나머지 도구는 허용.
// 모든 호출을 plan-calls.jsonl 에 남긴다.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const logf = join(here, 'plan-calls.jsonl')
let buf = ''
let plans = 0
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
function handle(m) {
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dure', version: '0.0.1' } } })
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'approve', description: 'Permission prompt', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } },
  ] } })
  if (m.method === 'tools/call') {
    const a = m.params.arguments
    let reply
    if (a.tool_name === 'ExitPlanMode' && ++plans === 1) {
      reply = { behavior: 'deny', message: '파일 이름을 hi.txt 로 바꿔서 계획을 다시 세워 주세요.' }
    } else {
      reply = { behavior: 'allow', updatedInput: a.input }
    }
    appendFileSync(logf, JSON.stringify({ at: Date.now(), tool: a.tool_name, inputKeys: Object.keys(a.input ?? {}), input: a.input, reply }) + '\n')
    return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } })
  }
  if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, result: {} })
}
