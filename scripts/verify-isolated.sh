#!/usr/bin/env bash
# 在不打扰正在运行的 dev server 的前提下完成全套验证。
#
# 为什么需要：`npm run build` 会写 `.next/`，与 `next dev` 冲突（已发生两次
# 页面损坏事故）。本脚本在**独立的构建目录**里跑生产构建，用完即删，
# dev server 完全不受影响。
#
# 用法：npm run verify:isolated
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# distDir 必须是**相对**路径（Next 忽略绝对路径），故用仓库内的临时目录
ISO_DIST=".next-verify"
cleanup() { rm -rf "$ISO_DIST"; }
trap cleanup EXIT

echo "════ 1/4 单元与集成测试 ════"
npx vitest run

echo
echo "════ 2/4 类型检查 ════"
npx tsc --noEmit
echo "tsc 干净"

echo
echo "════ 3/4 Lint ════"
npx next lint

echo
echo "════ 4/4 生产构建（输出到 ${ISO_DIST}，不碰 .next/）════"
# next.config.mjs 的 distDir 读 NEXT_DIST_DIR，生产构建因此完全绕开 .next/，
# 与正在运行的 dev server 互不干扰。
NEXT_DIST_DIR="$ISO_DIST" npx next build 2>&1 | tail -20
if [ ! -d "$ISO_DIST" ]; then
  echo "✖ 构建未产出到隔离目录 —— 隔离机制失效，请检查 next.config.mjs 的 distDir"
  exit 1
fi
echo "（构建产物已隔离在 ${ISO_DIST}，脚本退出时自动删除）"

echo
echo "✅ 全套验证通过（dev server 未受影响）"
