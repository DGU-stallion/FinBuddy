#!/usr/bin/env node
/**
 * IME（中文输入法）提单验证脚本
 *
 * ⚠️ 更正（重要）：本脚本验证的**不是**用户所说"对话出现两次"的真因。
 *   真因是服务端的流内事件顺序（data-* 写在 start 之前 → 两条 assistant 消息），
 *   见 scripts/single-render-check.mjs 与 app/api/chat/route.ts 第 0 步注释。
 *   我一度以为"两次"是输入法造成的，这个脚本也随之诞生 —— 它验证的缺陷
 *   （选词的 Enter 误触发提交）**确实存在且已修**，但**并非**用户看到的那个。
 *   保留本脚本，是因为它验证的这个缺陷是真的（一条独立缺陷，见缺陷表 #22）。
 *
 * 本脚本验证的缺陷：
 *   中文输入法打字时按 Enter 选词，这一下会被 `<form onSubmit>` 当成提交，
 *   把未打完的拼音（如 "shichang"）当成提问发出去。
 *
 * 用法：node scripts/ime-submit-check.mjs [baseUrl]
 *   前置：dev server 已在运行（npm run dev）
 *   退出码：0 = 行为正确；1 = 复现了误发
 *
 * 注：不消耗模型余额 —— 用 route 拦截 /api/chat 并立即回包。
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';

function findBrowser() {
  const base = path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(base)) return null;
  const found = [];
  for (const d of fs.readdirSync(base)) {
    for (const sub of ['chrome-mac-arm64', 'chrome-mac']) {
      const p = path.join(base, d, sub, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      if (fs.existsSync(p)) found.push(p);
    }
    const hs = path.join(base, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (fs.existsSync(hs)) found.push(hs);
  }
  return found.sort().pop() ?? null;
}

const exe = findBrowser();
if (!exe) {
  console.error('未找到 Chromium。安装：npx playwright install chromium');
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

/** 记录每次 /api/chat 的提问文本 —— 断言的是**用户看到的内容**，不只是次数。 */
const sent = [];
page.on('request', (r) => {
  if (r.method() !== 'POST' || !r.url().includes('/api/chat')) return;
  const m = (r.postData() || '').match(/"text":"([^"]*)"/);
  sent.push(m ? m[1] : '(无法解析)');
});

// 立即回包，不消耗余额；但仍走完整的客户端渲染路径
await page.route('**/api/chat', async (route) => {
  const body = [
    { type: 'start', messageId: 'a1' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: '（验证脚本占位回答）' },
    { type: 'text-end', id: 't' },
  ]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join('');
  await route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body,
  });
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const input = page.getByPlaceholder(/输入投资疑问/);
await input.click();
const cdp = await ctx.newCDPSession(page);
const ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
const pressEnterViaCDP = async () => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ENTER });
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...ENTER });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
};

// —— 真实中文输入法流程 ——
// 1) 打拼音，进入组词
await cdp.send('Input.imeSetComposition', {
  text: 'shichang',
  selectionStart: 8,
  selectionEnd: 8,
});
await page.waitForTimeout(300);

// 2) 按 Enter 选词（用户本意只是选候选词）
await pressEnterViaCDP();
await page.waitForTimeout(1200);

const afterPick = sent.length;
console.log(`[1] 用 Enter 选词后，发出的提问数：${afterPick}`);
for (const [i, s] of sent.entries()) console.log(`      #${i + 1} "${s}"`);

// 3) 打完完整问题，再按 Enter 真正提交
const QUESTION = '市场流传关于 1.6T 光模块配套光芯片价格下降的说法';
await input.fill(QUESTION);
await page.waitForTimeout(300);
await input.press('Enter');
await page.waitForTimeout(1500);

console.log(`[2] 完整提交后，累计提问数：${sent.length}`);
for (const [i, s] of sent.entries()) console.log(`      #${i + 1} "${s}"`);

await browser.close();

// —— 判定 ——
const leakedPinyin = sent.some((s) => /^[a-z\s]+$/i.test(s));
const duplicated = sent.length > 1;

if (leakedPinyin) {
  console.error(`\n❌ 复现：输入法选词的 Enter 被当成提交，发出了拼音 "${sent[0]}"`);
  process.exit(1);
}
if (duplicated) {
  console.error(`\n❌ 复现：一次提问发出 ${sent.length} 次请求`);
  process.exit(1);
}
if (sent.length !== 1 || sent[0] !== QUESTION) {
  console.error(`\n❌ 异常：期望恰好 1 次且文本为完整问题，实际 ${JSON.stringify(sent)}`);
  process.exit(1);
}
console.log('\n✅ 正确：选词未误发；完整问题恰好提交 1 次');
