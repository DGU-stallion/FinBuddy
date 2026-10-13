/** @type {import('next').NextConfig} */

/**
 * distDir 支持环境变量覆盖。
 *
 * 为什么需要：`next dev` 与 `next build` 默认都用 `.next/`，同时跑会互相污染，
 * 表现为 dev server 的 CSS/JS 全部 404（页面变成裸文字、完全失去交互），
 * 而 `next build` 仍显示成功 —— 属"不报错的失效"。此事故已发生两次。
 *
 * 因此 `npm run verify:isolated` 会把生产构建输出改到临时目录（NEXT_DIST_DIR），
 * 从而在**不打扰正在运行的 dev server** 的前提下完成完整验证。
 *
 * 注意：只在显式设置 NEXT_DIST_DIR 时生效；默认行为仍是 `.next`，不影响部署平台。
 */
const distDir = process.env.NEXT_DIST_DIR || '.next';

const nextConfig = {
  distDir,
  // 生产构建时不因 ESLint 配置问题中断（lint 已在 verify 流程里单独跑）
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
