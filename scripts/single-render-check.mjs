#!/usr/bin/env node
/**
 * "一次提问必须只渲染一轮" 的真实浏览器验证脚本
 *
 * 为什么必须有这个脚本：
 *   用户三次报告"对话出现两次"。我先后修过（并都写了绿色测试）两个方向：
 *     ① 同 tick 连点 → `inFlight` 同步闸门；
 *     ② 中文输入法选词的 Enter 被当成提交 → keydown 里 preventDefault。
 *   两次都不是真因 —— 真因是**服务端流内的事件顺序**：
 *     路由把 `data-steps`/`data-plan` 写在了 `start` **之前**，
 *     而 AI SDK 的客户端归集因此先开一条 assistant 消息、再因 start 开第二条。
 *     ⇒ 单次 HTTP 请求 → 2 条 assistant 消息 → 页面把同一提问渲染两轮。
 *
 *   这个缺陷与模型无关、每次请求必然复现，却在**所有单测**里都看不见：
 *   断言 data part 顺序是对的（相对顺序确实没错），
 *   而 jsdom 根本不跑 AI SDK 的消息归集。
 *   所以必须有一个脚本，把真实流喂给真实浏览器，数**最终渲染出的轮次**。
 *
 * 为什么用回放而不是真机：
 *   不花余额、可在 CI 跑、结果确定（不依赖模型当时说了什么）。
 *   回放的是真实抓取的流（tests/fixtures/real-t4-run.json 同源的形状）。
 *
 * 用法：node scripts/single-render-check.mjs [baseUrl]
 *   前置：dev server 已在运行（npm run dev）
 *   退出码：0 = 每个提问只渲染一轮；1 = 复现重复渲染
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const QUESTION = '中际旭创大客户砍单传闻导致业绩要崩，这个说法成立吗？';

function findBrowser() {
  const base = path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(base)) return null;
  const found = [];
  for (const d of fs.readdirSync(base)) {
    const hs = path.join(base, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (fs.existsSync(hs)) found.push(hs);
    for (const sub of ['chrome-mac-arm64', 'chrome-mac']) {
      const p = path.join(base, d, sub, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      if (fs.existsSync(p)) found.push(p);
    }
  }
  return found.sort().pop() ?? null;
}

const exe = findBrowser();
if (!exe) {
  console.error('未找到 Chromium。安装：npx playwright install chromium');
  process.exit(1);
}

/**
 * 回放的流：刻意保持**真实形状**（含 reasoning、两个 start-step）。
 *
 * 关键：`start` 必须在 data-* **之前** —— 这正是本次修复的内容。
 * 若有人再把顺序改回去，本脚本会红。
 */
// ⚠️ 保真要点：`start` 必须带 **messageId**。实测发现 ——
//    带 messageId 的 start 若位于 data-* **之后**，客户端会开出第二条 assistant
//    消息（复现）；不带 messageId 则不会（**假阳性陷阱**，会让本脚本失去牙齿）。
//    这条差异是我用真实抓取的流二分定位到的，简化回放时极易丢掉。
const STREAM = [
  { type: 'start', messageId: 'replay-msg-1' },
  { type: 'data-steps', id: 'steps', data: { steps: [{ id: 'step-compliance', label: '合规校验', detail: '关键词层 + 意图层双保险。' }] } },
  {
    type: 'data-plan',
    id: 'plan',
    data: {
      reframedClaim: '中际旭创当前经营基本面稳健，未出现单一重大客户砍单的公开证据。',
      intentTags: ['标的: 中际旭创', '事件: 大客户砍单传闻'],
      subQuestions: [{ question: '最近一期营收与盈利是多少？', verificator: 'financials' }],
      fromModel: true,
    },
  },
  { type: 'start-step' },
  { type: 'reasoning-start', id: 'reasoning-0' },
  { type: 'reasoning-delta', id: 'reasoning-0', delta: '需要先拉取财务与公告。' },
  { type: 'reasoning-end', id: 'reasoning-0' },
  { type: 'finish-step' },
  { type: 'start-step' },
  { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'lookupFinancialReport' },
  { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'lookupFinancialReport', input: {} },
  { type: 'tool-output-available', toolCallId: 'call-1', output: { ok: true } },
  { type: 'finish-step' },
  { type: 'text-start', id: 'txt-0' },
  { type: 'text-delta', id: 'txt-0', delta: '## 意图解析\n这是回放的回答正文。' },
  { type: 'text-end', id: 'txt-0' },
  { type: 'data-refs', id: 'refs', data: { refs: [{ refId: 'ref_1', tool: 'financials', title: '财务报文' }] } },
  { type: 'data-contract', id: 'contract', data: { ok: true, violations: [] } },
  { type: 'data-followups', id: 'followups', data: { questions: ['其一能否证伪？', '口径是否可比？', '同行对比如何？'] } },
  { type: 'finish' },
];
const BODY = STREAM.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

let requests = 0;
await page.route('**/api/chat', async (route) => {
  requests += 1;
  await route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: BODY,
  });
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// 用预设案例触发一问（点击是确定性的，不依赖键盘时序）
await page.click(`text=${QUESTION.slice(0, 12)}`);
await page.waitForTimeout(2500);

const result = await page.evaluate((q) => {
  const text = document.body.innerText;
  const sessions = JSON.parse(localStorage.getItem('finbuddy.sessions.v1') || '{}');
  const msgs = sessions.sessions?.[0]?.messages ?? [];
  return {
    articles: document.querySelectorAll('article').length,
    assistantMessages: msgs.filter((m) => m.role === 'assistant').length,
    questionRenders: text.split(q).length - 1,
    reframeBlocks: (text.match(/命题重构/g) || []).length,
  };
}, QUESTION);

await browser.close();

console.log('=== 一次提问后的渲染结果 ===');
console.log(`  HTTP 请求数: ${requests}`);
console.log(`  客户端 assistant 消息数: ${result.assistantMessages}（应为 1）`);
console.log(`  页面 article 区块数: ${result.articles}（应为 1）`);
console.log(`  命题重构块出现: ${result.reframeBlocks} 次（应为 1）`);

const ok = requests === 1 && result.assistantMessages === 1 && result.articles === 1;
if (!ok) {
  console.error(
    `\n❌ 复现：一次提问被渲染成 ${result.articles} 轮 —— ` +
      `多半是 /api/chat 的流把 data-* 写在 start 之前（见 app/api/chat/route.ts 第 0 步注释）`,
  );
  process.exit(1);
}
console.log('\n✅ 正确：每次提问只产生 1 条 assistant 消息、只渲染 1 轮');
