import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const work = new URL('./work4', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); mkdirSync(work, { recursive: true });
const p = spawn('claude', ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--model','haiku','--strict-mcp-config'], { cwd: work });
let buf=''; const t0=Date.now();
p.stdout.setEncoding('utf8');
p.stdout.on('data', d => { buf+=d; let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i); buf=buf.slice(i+1); if(!l.trim()) continue; const j=JSON.parse(l);
  if (j.type==='control_response') { const r=j.response?.response||{}; console.log("MODEL0", JSON.stringify(r.models[0]), "MODEL3", JSON.stringify(r.models[3]), "CMD keys", JSON.stringify(Object.keys(r.commands[0])), "perm", r.current_permission_mode, "session_state", JSON.stringify(r.session_state).slice(0,200), "acct keys", JSON.stringify(Object.keys(r.account||{}))); console.log(`+${Date.now()-t0}ms CTRL`, j.response.subtype, 'keys=', Object.keys(r).join(','), 'commands=', (r.commands||[]).length, JSON.stringify((r.commands||[]).slice(0,2)), 'models=', JSON.stringify((r.models||[]).map(m=>m.value||m).slice(0,8))); p.stdin.end(); }
  else console.log(`+${Date.now()-t0}ms`, j.type, j.subtype||''); } });
p.stderr.on('data', d => console.log('ERR', String(d).slice(0,200)));
p.stdin.write(JSON.stringify({ type:'control_request', request_id:'i1', request:{ subtype:'initialize' } })+'\n');
setTimeout(()=>{ console.log('timeout'); p.kill(); }, 30000);
