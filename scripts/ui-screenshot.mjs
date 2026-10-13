#!/usr/bin/env node
/**
 * UI 截图工具 —— 把页面真实渲染结果拍下来。
 *
 * 为什么需要它（这一课是用户教的）：本项目曾出现「489 条断言全绿，但用户打开
 * 页面说『只有文字没有 UI，也没有交互』」的情况。两次都是**工具链层面的静默失效**
 * （Tailwind 静默丢弃 `/98`；`.next` 缓存交叉污染导致 CSS 404）。
 * 逻辑单测再密也照不到这类问题 —— **只有真的看一眼**才能发现。
 *
 * 用法：
 *   node scripts/ui-screenshot.mjs                 # 空状态截图
 *   node scripts/ui-screenshot.mjs --with-fixture  # 注入真机 fixture，截完整分析界面
 *   node scripts/ui-screenshot.mjs --outdir ./tmp/shots
 *
 * 前置：dev server 已在 3000 端口运行（`npm run dev`）。
 *
 * 依赖 playwright-core + 系统已下载的 chromium。
 * 找不到浏览器时会明确报错并给出安装命令，不静默失败。
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.FINBUDDY_BASE_URL || 'http://localhost:3000';

const args = process.argv.slice(2);
const withFixture = args.includes('--with-fixture');
const outdir = (() => {
  const i = args.indexOf('--outdir');
  return i >= 0 && args[i + 1] ? args[i + 1] : path.join(ROOT, 'tmp', 'shots');
})();

/** 找一个可用的 chromium（playwright 缓存目录里可能装了多个版本）。 */
function findBrowser() {
  const base = path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(base)) return null;
  const found = [];
  for (const d of fs.readdirSync(base)) {
    for (const sub of ['chrome-mac-arm64', 'chrome-mac', 'chrome-linux']) {
      const p = path.join(base, d, sub, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      if (fs.existsSync(p)) found.push(p);
    }
    const hs = path.join(base, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (fs.existsSync(hs)) found.push(hs);
  }
  return found.sort().pop() ?? null;
}

/**
 * 用真机 fixture 回放 /api/chat 的流式响应。
 *
 * 为什么可以这样做：fixture（tests/fixtures/real-t4-run.json）是**真机抓取的真实
 * 响应**，不是编造数据。拦截后 UI 的渲染路径与真实链路完全相同，
 * 因此在模型余额耗尽时仍能验证界面。
 */
async function replayFixture(page, fixturePath) {
  const fix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  await page.route('**/api/chat', async (route) => {
    const chunks = [{ type: 'start', messageId: 'a1' }];
    for (const p of fix.parts) chunks.push({ type: p.type, id: p.id, data: p.data });
    chunks.push({ type: 'text-start', id: 'txt' });
    for (const seg of fix.body.split('\n')) chunks.push({ type: 'text-delta', id: 'txt', delta: seg + '\n' });
    chunks.push({ type: 'text-end', id: 'txt' });
    chunks.push({ type: 'finish' });
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''),
    });
  });
}

/** 抓关键元素的计算样式 —— 比截图更客观，可断言。 */
async function computedStyles(page) {
  return page.evaluate(() => {
    const g = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    return {
      bodyBg: g('body', 'backgroundColor'),
      bodyColor: g('body', 'color'),
      bodyFont: g('body', 'fontSize'),
      h1: g('h1', 'fontSize'),
      input: g('input', 'fontSize'),
      button: g('button', 'fontSize'),
    };
  });
}

(async () => {
  const exe = findBrowser();
  if (!exe) {
    console.error(
      '未找到 Chromium。安装：npx playwright install chromium\n' +
        '（若用 playwright-core，需系统已有浏览器缓存）',
    );
    process.exit(1);
  }
  fs.mkdirSync(outdir, { recursive: true });

  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  if (withFixture) {
    await replayFixture(page, path.join(ROOT, 'tests', 'fixtures', 'real-t4-run.json'));
  }

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  if (withFixture) {
    // 走一轮完整渲染（fixture 回放，无需模型余额）
    await page.getByText('中际旭创 · 大客户砍单核验').click();
    await page.waitForTimeout(3000);
  }

  const empty = path.join(outdir, withFixture ? 'analysis.png' : 'empty.png');
  await page.screenshot({ path: empty });
  console.log(`✅ ${empty}`);

  if (withFixture) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const bottom = path.join(outdir, 'analysis-bottom.png');
    await page.screenshot({ path: bottom });
    console.log(`✅ ${bottom}`);

    const info = await page.evaluate(() => {
      const t = document.body.innerText;
      return {
        三栏齐全: t.includes('支持证据') && t.includes('反对证据') && t.includes('无法验证'),
        有追问: t.includes('继续核验'),
        有测算卡: t.includes('营收冲击推演'),
      };
    });
    console.log('渲染内容核查:', JSON.stringify(info));
  }

  console.log('\n实际计算样式:', JSON.stringify(await computedStyles(page), null, 2));
  await browser.close();
})();
