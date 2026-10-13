/**
 * T5 验证：把两份**真机 SSE** 分别喂给 deriveViews，打印票面各项的实测值。
 * 用真实输出核对"预置案例一键出完整链路"是否成立，而不是靠推断。
 */
import { readFileSync } from 'node:fs';
import { deriveViews } from '../lib/message-view';

function parseSse(raw: string) {
  const parts: any[] = [];
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const p = line.slice(6).trim();
    if (p === '[DONE]') continue;
    let e: any;
    try { e = JSON.parse(p); } catch { continue; }
    if (e.type === 'text-delta') text += e.delta ?? '';
    else if (typeof e.type === 'string' && e.type.startsWith('data-')) {
      parts.push({ type: e.type, id: e.id, data: e.data });
    }
  }
  if (text) parts.push({ type: 'text', text, state: 'done' });
  return parts;
}

const cases = [
  ['中际旭创 大客户砍单', '/tmp/t4-run.sse', '中际旭创大客户砍单传闻导致业绩要崩，这个说法成立吗？'],
  ['宁德时代 固态电池跳票', '/tmp/real2.sse', '网传宁德时代固态电池量产跳票，公告里有相关披露吗？'],
] as const;

for (const [name, file, q] of cases) {
  const parts = parseSse(readFileSync(file, 'utf8'));
  const v = deriveViews({
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: q }] },
      { id: 'a1', role: 'assistant', parts },
    ] as never,
  })[0];

  console.log('=== ' + name + ' ===');
  console.log('  kind=' + v.kind + '  refs=' + v.refs.length + '  contract.ok=' + v.contract?.ok + '  followUps=' + v.followUps.length);
  const p = v.sensitivityParams;
  console.log('  测算参数: ' + (p
    ? 'baseRevenue=' + (p.baseRevenue / 1e8).toFixed(2) + '亿 netMargin=' + p.netMargin + '% tax=' + p.taxRate + '% basis=' + p.revenueBasis + ' ref=' + p.refId
    : 'NULL'));
  const cols = ['支持证据', '反对证据', '无法验证项'].map((n) => {
    const m = v.body.match(new RegExp('【' + n + '】([\\s\\S]*?)(?=【|$)'));
    return m && m[1].trim().length > 20 ? '✓' : '✗';
  });
  console.log('  三栏(支持/反对/无法验证)=' + cols.join('') + '  body=' + v.body.length + ' 字');
  console.log('  存证种类: ' + [...new Set(v.refs.map((r) => r.kind))].join(', '));
}
