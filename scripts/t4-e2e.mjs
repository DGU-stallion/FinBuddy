/**
 * T4 端到端验证：把**真机 SSE** 喂给前端视图模型（deriveViews），
 * 验证浏览器侧链路（data part → 三栏/角标/抽屉/测算参数）在真实输出上成立。
 *
 * 用法：
 *   1) 起 dev server：npx next dev
 *   2) curl 落一份真实 SSE（见 README/票面），或直接让本脚本发请求：
 *      node scripts/t4-e2e.mjs --live
 *   3) node scripts/t4-e2e.mjs <sse-file>
 *
 * 为什么不用 mock：mock 只能证明"我按我以为的形状解析"，不能证明"真实链路能跑通"。
 * 本脚本与 T3 的 compliance-suite 同思路 —— 用真实输出做验收。
 *
 * 纯校验、只读：不写任何文件，不发合规之外的请求。
 */

import { readFileSync } from 'node:fs';

const SSE_FILE = process.argv[2] ?? '/tmp/t4-run.sse';
const BASE = process.env.FINBUDDY_BASE_URL ?? 'http://localhost:3000';

/** 把 SSE 文本还原成 UIMessage 的 parts（与浏览器 useChat 得到的一致）。 */
export function parseSseToMessages(sseText, userText) {
  const parts = [];
  let textBuf = '';
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    if (ev.type === 'text-delta') textBuf += ev.delta ?? '';
    else if (typeof ev.type === 'string' && ev.type.startsWith('data-')) {
      parts.push({ type: ev.type, id: ev.id, data: ev.data });
    }
  }
  if (textBuf) parts.push({ type: 'text', text: textBuf, state: 'done' });

  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: userText }] },
    { id: 'a1', role: 'assistant', parts },
  ];
}

/** 轮询等待 dev server 就绪（避免把"服务没起来"误报成"链路坏了"）。 */
async function waitForServer(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function main() {
  const { deriveViews } = await import('../lib/message-view.ts');

  if (!(await waitForServer())) {
    console.error(`✗ dev server 未就绪：${BASE}`);
    process.exit(2);
  }

  let sse;
  let userText;
  if (process.argv.includes('--live')) {
    userText = process.env.T4_QUESTION ?? '中际旭创大客户砍单传闻导致业绩要崩，这个说法成立吗？';
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: userText }] }],
      }),
    });
    sse = await r.text();
  } else {
    sse = readFileSync(SSE_FILE, 'utf8');
    userText = '（来自落盘的 SSE）';
  }

  const views = deriveViews({ messages: parseSseToMessages(sse, userText) });
  const v = views[0];
  console.log('kind          =', v.kind);
  console.log('steps         =', v.steps.length);
  console.log('plan.fromModel=', v.plan?.fromModel);
  console.log('intentTags    =', JSON.stringify(v.plan?.intentTags));
  console.log('refs          =', v.refs.map((r) => `${r.refId}(${r.kind})`).join(', '));
  console.log('allowedRefIds =', v.allowedRefIds.join(', '));
  console.log('contract.ok   =', v.contract?.ok, 'violations=', v.contract?.violations.length);
  console.log('followUps     =', v.followUps.length);
  console.log('degraded      =', v.degraded ? v.degraded.text.slice(0, 60) : 'null');
  console.log(
    'sensitivity   =',
    v.sensitivityParams
      ? `baseRevenue=${v.sensitivityParams.baseRevenue} netMargin=${v.sensitivityParams.netMargin} tax=${v.sensitivityParams.taxRate} basis=${v.sensitivityParams.revenueBasis}`
      : 'null',
  );
  console.log('body chars    =', v.body.length);
  console.log('nonEmptyCols  =', ['支持证据', '反对证据', '无法验证项'].filter((n) => {
    const m = v.body.match(new RegExp(`【${n}】([\\s\\S]*?)(?=【|$)`));
    return m && m[1].trim().length > 0 && !/^(无|暂无|没有|待补充)$/.test(m[1].trim());
  }).join(', '));
}

main().catch((e) => {
  console.error('✗ 失败：', e);
  process.exit(1);
});
