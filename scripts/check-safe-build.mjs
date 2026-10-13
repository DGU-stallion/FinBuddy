#!/usr/bin/env node
/**
 * 构建前置守卫：检测 dev server 是否正在运行。
 *
 * 为什么需要（真实事故，发生过两次）：
 *   `npm run dev` 与 `npm run build` 都要写 `.next/` 目录。若在 dev server
 *   运行期间执行生产构建，两者产物互相污染 —— dev server 内存中缓存的文件
 *   引用会指向已被替换/删除的文件，表现为：
 *     · CSS 请求 404（页面变成裸 HTML 文字）
 *     · JS chunk 全 404（页面完全失去交互）
 *     · 控制台刷 `__webpack_modules__[moduleId] is not a function`
 *
 * 最恶劣的地方是**静默**：`npm run build` 自己会显示 "Compiled successfully"，
 * 测试全绿，lint 干净 —— 只有人打开浏览器才发现页面坏了。
 *
 * 第一次发生时我以为是偶发，只在文档里写了排障步骤；第二次再犯，
 * 说明"记得别这么干"不是可靠方案。故改为机器拦截。
 *
 * 退出码：0 = 可以构建；1 = 检测到 dev server，拒绝构建。
 * 允许显式绕过：FINBUDDY_ALLOW_BUILD_WITH_DEV=1（明知风险时用）
 */

import net from 'node:net';

const PORT = Number(process.env.PORT || 3000);

if (process.env.FINBUDDY_ALLOW_BUILD_WITH_DEV === '1') {
  console.log('⚠️  FINBUDDY_ALLOW_BUILD_WITH_DEV=1：跳过 dev server 检测。');
  console.log('   注意：这会污染 .next/，dev server 的页面会坏掉。');
  process.exit(0);
}

/** 探测端口是否有服务在监听。 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(700);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

const inUse = await isPortInUse(PORT);

if (inUse) {
  console.error(`
✖ 检测到 ${PORT} 端口有服务在运行，拒绝执行生产构建。

  原因：\`next dev\` 与 \`next build\` 共用 \`.next/\` 目录，交叉写入会让
  **dev server 的页面坏掉**（CSS/JS 全 404），而 \`next build\` 自身仍显示成功
  —— 属于"不报错的失效"，只能靠人打开浏览器发现。此事故已发生两次。

  请任选其一：
    1) 停止 dev server（Ctrl+C），再构建：
         npm run build
    2) 只是想看界面 → 无需构建，dev server 已在跑：
         打开 http://localhost:${PORT}
    3) 确实需要同时构建（明知会污染 dev）：
         FINBUDDY_ALLOW_BUILD_WITH_DEV=1 npm run build
       构建后务必重启 dev：npm run dev:clean

  若想跑完整验证又不打扰 dev server，用：
         npm run verify:isolated
`);
  process.exit(1);
}

process.exit(0);
