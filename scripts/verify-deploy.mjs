#!/usr/bin/env node
/**
 * 部署后验证脚本 —— 一条命令验证 4 件事。
 *
 * 用法：
 *   node scripts/verify-deploy.mjs https://你的域名
 *   node scripts/verify-deploy.mjs                    # 默认 http://localhost:3000
 *
 * 为什么需要这个脚本：**首页能打开不等于部署成功**。这类应用最典型的
 * 部署故障是「功能正确但 SSE 被反向代理缓冲」—— 浏览器里表现为"一直转圈
 * 不输出"，很容易被误判成"模型慢"。第 4 项检查专门抓这个。
 *
 * 退出码：0 = 全部通过；1 = 有失败（打印哪一项、为什么、怎么修）。
 */

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

const ASK_BODY = (text) => ({
  messages: [{ id: 'probe', role: 'user', parts: [{ type: 'text', text }] }],
});

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (detail) for (const line of detail.split('\n')) console.log(`     ${line}`);
};

/** 带超时的 fetch（部署验证不能挂死）。 */
async function timedFetch(url, opts = {}, timeoutMs = 180_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- 1) 首页可访问 ----------
async function checkHome() {
  try {
    const r = await timedFetch(`${BASE}/`, {}, 30_000);
    const body = await r.text();
    // 不只看状态码：确认返回的确实是我们的页面（而不是托管平台的占位页/错误页）
    const isOurs = body.includes('FinBuddy') || body.includes('问财') || body.includes('可证伪');
    const ok = r.status === 200 && isOurs;
    record(
      '1) 首页可访问且是我们的页面',
      ok,
      ok
        ? `HTTP 200，页面内容匹配`
        : `HTTP ${r.status}；页面内容${isOurs ? '匹配' : '**不匹配**（可能是平台占位页/错误页）'}`,
    );
  } catch (e) {
    record('1) 首页可访问且是我们的页面', false, `请求失败：${e.message}`);
  }
}

// ---------- 2) 完整链路产出 5 个 data part ----------
async function checkPipeline() {
  const EXPECTED = ['steps', 'plan', 'refs', 'contract', 'followups'];
  try {
    const r = await timedFetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ASK_BODY('中际旭创怎么样')),
    });
    const text = await r.text();
    const found = new Set(
      [...text.matchAll(/data-([a-z]+)/g)].map((m) => m[1]).filter((n) => EXPECTED.includes(n)),
    );
    const missing = EXPECTED.filter((n) => !found.has(n));
    const ok = r.status === 200 && missing.length === 0;
    record(
      '2) 预置案例走完整链路（5 个 data part 齐全）',
      ok,
      ok
        ? `全部到达：${EXPECTED.join(' / ')}`
        : `HTTP ${r.status}；缺少 ${missing.join(' / ')}\n` +
          `可能原因：环境变量未配全（模型/网关 key）、maxDuration 过短被中断`,
    );
  } catch (e) {
    record('2) 预置案例走完整链路（5 个 data part 齐全）', false, `请求失败：${e.message}`);
  }
}

// ---------- 3) 合规路径确实拦截 ----------
async function checkCompliance() {
  try {
    const r = await timedFetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ASK_BODY('请直接告诉我明天买入还是卖出')),
    });
    const text = await r.text();
    const hasSignal = text.includes('data-compliance');
    const leakedAnalysis = text.includes('【支持证据】');
    const ok = hasSignal && !leakedAnalysis;
    record(
      '3) 合规路径拦截（且未漏出三栏分析）',
      ok,
      ok
        ? '收到 data-compliance 信号，正文无三栏分析'
        : [
            hasSignal ? '' : '未收到 data-compliance 信号（合规层未生效）',
            leakedAnalysis ? '**正文出现了三栏分析 —— 合规被绕过**' : '',
          ]
            .filter(Boolean)
            .join('\n'),
    );
  } catch (e) {
    record('3) 合规路径拦截（且未漏出三栏分析）', false, `请求失败：${e.message}`);
  }
}

// ---------- 4) SSE 未被缓冲（最容易被忽略的一项）----------
async function checkStreaming() {
  try {
    const t0 = Date.now();
    const r = await timedFetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ASK_BODY('中际旭创怎么样')),
    });
    if (!r.ok || !r.body) {
      record('4) SSE 流式未被缓冲', false, `HTTP ${r.status}，无法读取流`);
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    const arrivalTimes = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      arrivalTimes.push(Date.now() - t0);
    }
    const total = Date.now() - t0;

    // 判据：若被缓冲，服务端会把整个响应攒完再一次性发出 →
    // 所有 chunk 的到达时间几乎相同（且首个 ≈ 总耗时）。
    // 若未被缓冲，首个 data part（steps 是确定性编排、立即发出）会**远早于**总耗时。
    const ttfb = arrivalTimes[0] ?? total;
    const spread = (arrivalTimes.at(-1) ?? 0) - ttfb;
    const ttfbRatio = total > 0 ? ttfb / total : 1;

    // 双判据，任一满足即认为未被缓冲：
    //  a) 首字节明显早于总耗时（< 60%）
    //  b) chunk 到达时间有明显跨度（> 300ms，说明是逐个流出的）
    const notBuffered = ttfbRatio < 0.6 || spread > 300;
    record(
      '4) SSE 流式未被缓冲',
      notBuffered,
      [
        `总耗时 ${total}ms，首字节 ${ttfb}ms（占比 ${(ttfbRatio * 100).toFixed(0)}%），` +
          `chunk 到达跨度 ${spread}ms，共 ${arrivalTimes.length} 个 chunk / ${bytes} 字节`,
        notBuffered
          ? '流是逐步到达的，未被缓冲'
          : '**所有 chunk 几乎同时到达 —— SSE 被反向代理缓冲了**\n' +
            '  修法（Nginx）：proxy_buffering off; proxy_cache off; proxy_read_timeout 300s;\n' +
            '                  proxy_set_header Connection \'\'; proxy_http_version 1.1;',
      ].join('\n'),
    );
  } catch (e) {
    record('4) SSE 流式未被缓冲', false, `请求失败：${e.message}`);
  }
}

// ---------- main ----------
(async () => {
  console.log(`部署验证 → ${BASE}\n`);
  await checkHome();
  await checkPipeline();
  await checkCompliance();
  await checkStreaming();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log(`\n未通过：${failed.map((f) => f.name).join('；')}`);
    process.exit(1);
  }
  console.log('\n部署验证全部通过。建议把本段输出抄进 DEPLOY.md 留痕。');
})();
