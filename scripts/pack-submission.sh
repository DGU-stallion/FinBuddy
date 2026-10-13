#!/usr/bin/env bash
#
# 打包提交物：把源码 + 全部文档打成一个 ZIP。
#
# 用法：
#   ./scripts/pack-submission.sh          # 输出 FinBuddy-submission.zip（仓库根目录）
#   ./scripts/pack-submission.sh out.zip  # 指定输出路径
#
# 产物结构（顶层带一个目录，避免解压时把文件撒得到处都是）：
#   FinBuddy/
#     README.md  app/  lib/  docs/  ...  .env.example
#
# 排除的内容与原因：
#   node_modules/   —— 依赖，README 里 npm install 一条命令就能重建（几百 MB）
#   .next*          —— 构建产物，npm run build 重建
#   .git/           —— 版本历史，仓库另有 GitHub 地址
#   .env            —— ⚠️ 真实密钥，绝不能进提交包（脚本会强制断言）
#   tmp/            —— 含一次误入库的 Next 构建产物（162MB，见 deploy/README.md）
#
# ⚠️ 密钥处理（这是本脚本最要紧的部分）：
#   ZIP 里**不放** .env。收到包的人按 README「快速开始」创建自己的 .env。
#   脚本结尾会真的解压检查一遍有没有漏出密钥 —— 不是靠"我记得排除了"。
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="${1:-FinBuddy-submission.zip}"
OUT_ABS="$ROOT/$OUT"
# ZIP 内的顶层目录名
PKG_NAME="FinBuddy"

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; RESET=$'\033[0m'
log() { printf '\n%s▶ %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()  { printf '%s✓ %s%s\n' "$GREEN" "$*" "$RESET"; }
warn(){ printf '%s⚠ %s%s\n' "$YELLOW" "$*" "$RESET"; }
die() { printf '%s✖ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

command -v zip >/dev/null 2>&1 || die "缺少 zip 命令（macOS 自带；Linux: apt install zip）"
command -v rsync >/dev/null 2>&1 || die "缺少 rsync 命令"

log "1/4 打包前的安全检查"

if [ -f .env ]; then
  warn "检测到 .env（含真实密钥）—— 它会被排除，但请确认你知道自己在打包什么"
fi

log "2/4 暂存到 ${PKG_NAME}/ 并生成 ZIP"

STAGE="$(mktemp -d)"
TMPX="$(mktemp -d)"
cleanup() { rm -rf "$STAGE" "$TMPX"; }
trap cleanup EXIT

# 用 rsync 暂存：既能加顶层目录名，又能集中管理排除规则
rsync -a \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  --exclude '.next-verify/' \
  --exclude 'tmp/' \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env.*.local' \
  --exclude 'deploy/.env.deploy' \
  --exclude '.DS_Store' \
  --exclude '*.tsbuildinfo' \
  --exclude 'coverage/' \
  --exclude '*.zip' \
  ./ "$STAGE/$PKG_NAME/"

rm -f "$OUT_ABS"
( cd "$STAGE" && zip -r -q "$OUT_ABS" "$PKG_NAME" )

SIZE="$(du -h "$OUT_ABS" | cut -f1)"
COUNT="$(unzip -l "$OUT_ABS" | tail -1 | awk '{print $2}')"
ok "已生成 ${OUT}（${SIZE}，${COUNT} 个文件）"

log "3/4 强制校验：ZIP 里没有密钥"

# 真的解压清单来查，而不是依赖上面的 --exclude 写对了
LEAKED="$(unzip -l "$OUT_ABS" | awk '{print $4}' \
  | grep -E '(^|/)\.env$|(^|/)\.env\.local$|(^|/)\.env\.production\.local$' || true)"
if [ -n "$LEAKED" ]; then
  rm -f "$OUT_ABS"
  die "ZIP 中出现了密钥文件：$LEAKED —— 已删除产物，请检查排除规则"
fi
ok "确认无 .env / .env.local"

log "4/4 解压扫描：确认无残留密钥值"

unzip -q "$OUT_ABS" -d "$TMPX"

# 用本地 .env 里的真实值逐个反查，确认它们没有出现在包内任何文件中
FOUND=0
for key in DEEPSEEK_API_KEY FUYAO_API_KEY IFIND_MCP_KEY; do
  val="$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
  if [ -n "$val" ] && grep -rqF "$val" "$TMPX" 2>/dev/null; then
    printf '%s✖ 密钥 %s 的值出现在包内！%s\n' "$RED" "$key" "$RESET" >&2
    FOUND=1
  fi
done

if [ "$FOUND" = "1" ]; then
  rm -f "$OUT_ABS"
  die "包内检出真实密钥值 —— 已删除产物，必须排查后再打包"
fi
ok "本地 3 个密钥的值均未出现在包内"

echo
printf '%s════════════════════════════════════════════════════════%s\n' "$BOLD" "$RESET"
printf ' 提交包就绪：%s\n' "$OUT"
printf ' 大小 %s，%s 个文件\n' "$SIZE" "$COUNT"
printf ' 顶层目录：%s/（解压后不会把文件撒到当前目录）\n' "$PKG_NAME"
printf '%s════════════════════════════════════════════════════════%s\n' "$BOLD" "$RESET"
echo
echo " 收到包的人怎么跑起来（README「快速开始」有完整说明）："
echo "   unzip $OUT        # → 得到 ${PKG_NAME}/ 目录"
echo "   cd $PKG_NAME"
echo "   cp .env.example .env    # 填入 4 个密钥"
echo "   npm install && npm run dev"
echo "   → 浏览器打开 http://localhost:3000"
