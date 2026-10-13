#!/usr/bin/env bash
#
# FinBuddy 一键部署（在本地 Mac 上执行）
#
# 用法：
#   ./deploy/deploy.sh              # 部署当前 commit
#   ./deploy/deploy.sh --check      # 只做预检，不上传不部署
#   ./deploy/deploy.sh <git-sha>    # 部署指定的 commit（推荐：钉住版本）
#
# 设计要点（每条都对应一个真实风险）：
#
#  1. **钉 commit，而不是 rsync 工作区**。
#     本仓库经常有并行会话在改动（app/page.tsx 已修改、lib/session-store.ts 等未提交）。
#     直接同步工作区会把半成品推上线。这里用 `git archive <SHA>` 只导出**已提交**
#     的内容，未提交的改动天然被排除。
#
#  2. **构建在服务器上做，但必须先有 swap**（由 remote-setup.sh 保证）。
#     1GB 内存跑 Next.js 生产构建大概率 OOM。
#
#  3. **部署后自动验证，4/4 未通过就非零退出**。
#     仓库规则明确：不写没发生的完成态文档。脚本不撒谎 —— 验证失败就是失败。
#
#  4. **应用跑 3001 而非 3000**，避免触发仓库自带的构建守卫（见 deploy/README.md）。
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 输出helpers ─────────────────────────────────────────────
BOLD=$'\033[1m'; BLUE=$'\033[1;34m'; GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; RESET=$'\033[0m'
log()  { printf '\n%s▶ %s%s\n' "$BLUE" "$*" "$RESET"; }
ok()   { printf '%s✓ %s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s⚠ %s%s\n' "$YELLOW" "$*" "$RESET"; }
die()  { printf '\n%s✖ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# ── 读取配置 ───────────────────────────────────────────────
CONFIG="deploy/.env.deploy"
if [ ! -f "$CONFIG" ]; then
  die "缺少 $CONFIG
   先复制模板： cp deploy/.env.deploy.example deploy/.env.deploy
   然后填入你的 SSH 别名。"
fi
# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a

SSH_HOST="${FINBUDDY_SSH_HOST:?未在 $CONFIG 中设置 FINBUDDY_SSH_HOST}"
REMOTE_DIR="${FINBUDDY_REMOTE_DIR:-/opt/finbuddy}"
APP_PORT="${FINBUDDY_APP_PORT:-3001}"
REMOTE_APP="$REMOTE_DIR/app"

CHECK_ONLY=0
TARGET_SHA=""
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) TARGET_SHA="$arg" ;;
  esac
done

# ═══════════════════════════════════════════════════════════
# 阶段 1：预检（本地）
# ═══════════════════════════════════════════════════════════
log "1/7 本地预检"

# 1a. git 仓库必须干净到"可解释"的程度
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  die "当前目录不是 git 仓库"
fi

if [ -n "$TARGET_SHA" ]; then
  if ! git rev-parse --verify --quiet "$TARGET_SHA^{commit}" >/dev/null; then
    die "找不到 commit：$TARGET_SHA"
  fi
  DEPLOY_SHA="$(git rev-parse "$TARGET_SHA^{commit}")"
  ok "指定部署 commit：${DEPLOY_SHA:0:8}"
else
  DEPLOY_SHA="$(git rev-parse HEAD)"
  ok "部署当前 HEAD：${DEPLOY_SHA:0:8}"
fi

echo "  commit 说明：$(git log -1 --format=%s "$DEPLOY_SHA")"

# 明确告知：未提交的改动**不会**被部署（这是刻意的保护，不是遗漏）
DIRTY="$(git status --porcelain | grep -v '^?? deploy/' || true)"
if [ -n "$DIRTY" ]; then
  warn "工作区有未提交改动，它们不会被部署（脚本只导出已提交内容）："
  echo "$DIRTY" | sed 's/^/      /'
fi

# 1b. 密钥必须齐备且非空
if [ ! -f .env ]; then
  die "缺少本地 .env（4 个密钥的来源）。参考 .env.example 创建。"
fi

REQUIRED_KEYS=(DEEPSEEK_API_KEY FUYAO_API_KEY IFIND_MCP_KEY)
MISSING=()
for key in "${REQUIRED_KEYS[@]}"; do
  # 取出值，去掉可能的引号与空白
  val="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
  if [ -z "$val" ]; then MISSING+=("$key"); fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  die "以下密钥在 .env 中为空：${MISSING[*]}
   没有它们，应用会在运行时 fail-closed 拦下所有提问（表现为"全被合规拦截"）。"
fi
ok "3 个必需密钥均已配置（值不打印）"

# 1c. 确认 .env 未被 git 跟踪（防止密钥泄露）
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  die ".env 已被 git 跟踪！密钥有泄露风险，请立即 git rm --cached .env"
fi
ok ".env 未被 git 跟踪"

# 1d. SSH 连通性
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" 'echo ok' >/dev/null 2>&1; then
  die "无法免密 SSH 到 '$SSH_HOST'。
   检查 ~/.ssh/config 是否有对应的 Host 条目，且公钥已上传：
     ssh-copy-id -i ~/.ssh/id_ed25519.pub root@<服务器IP>
     ssh $SSH_HOST 'echo 通了'"
fi
ok "SSH 免密连通：$SSH_HOST"

if [ "$CHECK_ONLY" = "1" ]; then
  log "预检通过（--check 模式，未上传任何内容）"
  exit 0
fi

# ═══════════════════════════════════════════════════════════
# 阶段 2：把服务器初始化脚本与配置送过去
# ═══════════════════════════════════════════════════════════
log "2/7 上传服务器初始化脚本与配置文件"

scp -q deploy/remote-setup.sh "$SSH_HOST:/tmp/finbuddy-remote-setup.sh"
scp -q deploy/nginx.conf      "$SSH_HOST:/tmp/nginx-finbuddy.conf"
scp -q deploy/finbuddy.service "$SSH_HOST:/tmp/finbuddy.service"
ok "已上传 remote-setup.sh / nginx.conf / finbuddy.service"

# ═══════════════════════════════════════════════════════════
# 阶段 3：服务器初始化（幂等）
# ═══════════════════════════════════════════════════════════
log "3/7 服务器初始化（swap / Node / Nginx / systemd）—— 首次约 2–5 分钟"

ssh "$SSH_HOST" "FINBUDDY_REMOTE_DIR='$REMOTE_DIR' FINBUDDY_APP_PORT='$APP_PORT' bash /tmp/finbuddy-remote-setup.sh"

# ═══════════════════════════════════════════════════════════
# 阶段 4：导出**指定 commit** 的源码并上传
# ═══════════════════════════════════════════════════════════
log "4/7 打包并上传源码（钉在 ${DEPLOY_SHA:0:8}）"

TARBALL="$(mktemp -t finbuddy-src.XXXXXX).tar.gz"
trap 'rm -f "$TARBALL"' EXIT

# git archive 只导出该 commit 已跟踪的文件 —— 未提交改动与 .env 天然排除。
#
# `:(exclude)tmp` 是纵深防御，不是优化：仓库里 `tmp/iso-probe/` 曾是一次 Next 构建
# 产物被误提交（commit e1c4713），占 162MB / 178 个文件。该误提交已于 2026-10-13 修复
# （`git rm -r --cached` + `.gitignore` 补 `tmp/iso-*/`），但 keep 这条排除规则可以保证：
# 即使将来又误提交同类产物，部署包也不会被拖大。排除后是 476KB / 151 文件。
git archive --format=tar.gz -o "$TARBALL" "$DEPLOY_SHA" -- . ':(exclude)tmp'
SRC_SIZE="$(du -h "$TARBALL" | cut -f1)"
ok "源码包已生成：${SRC_SIZE}（已排除 tmp/ 构建产物）"

# 确认包里没有密钥（防御性检查：万一 .env 哪天被误提交）
if tar -tzf "$TARBALL" | grep -qxE '\.env|\.env\.local|\.env\.production\.local'; then
  die "源码包中出现 .env —— 已中止部署。请先把它从 git 中移除。"
fi
ok "源码包内确认无 .env"

ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR' && rm -rf '$REMOTE_DIR/src' && mkdir -p '$REMOTE_DIR/src'"
scp -q "$TARBALL" "$SSH_HOST:$REMOTE_DIR/src.tar.gz"

# 用 version.txt 记录线上跑的是哪个 commit，便于回溯
printf '%s\n%s\n' "$DEPLOY_SHA" "$(git log -1 --format=%s "$DEPLOY_SHA")" > /tmp/finbuddy-version.txt
scp -q /tmp/finbuddy-version.txt "$SSH_HOST:$REMOTE_DIR/version.txt"
rm -f /tmp/finbuddy-version.txt
ok "已上传源码包与版本标记"

# ═══════════════════════════════════════════════════════════
# 阶段 5：投递密钥
# ═══════════════════════════════════════════════════════════
log "5/7 投递环境变量"

# 只投递应用需要的变量，不带任何本地开发用的东西
TMPENV="$(mktemp -t finbuddy-env.XXXXXX)"
trap 'rm -f "$TARBALL" "$TMPENV"' EXIT
{
  echo "# 由 deploy/deploy.sh 自动生成 —— 请勿手动编辑（重新部署会覆盖）"
  echo "# 生成时间：$(date '+%Y-%m-%d %H:%M:%S')"
  echo "# 来源 commit：$DEPLOY_SHA"
  echo
  for key in DEEPSEEK_API_KEY DEEPSEEK_BASE_URL FUYAO_API_KEY IFIND_MCP_KEY; do
    line="$(grep -E "^${key}=" .env | head -1 || true)"
    if [ -n "$line" ]; then echo "$line"; fi
  done
} > "$TMPENV"

chmod 600 "$TMPENV"
ssh "$SSH_HOST" "mkdir -p '$REMOTE_APP'"
scp -q "$TMPENV" "$SSH_HOST:$REMOTE_APP/.env"
ssh "$SSH_HOST" "chmod 600 '$REMOTE_APP/.env'"
ok "已投递 .env（权限 600，仅含应用所需 4 个变量）"

# ═══════════════════════════════════════════════════════════
# 阶段 6：服务器上解包、构建、重启
# ═══════════════════════════════════════════════════════════
log "6/7 服务器上构建并重启服务（首次约 8–20 分钟，请勿中断）"
echo "    构建期间内存会吃满 + 走 swap，属正常现象。"
echo

# 注意：这里**不能**先停服务再构建。
# 原因：scripts/check-safe-build.mjs 会拒绝"有服务占用端口时构建"，
# 但它探测的是 3000 端口，而应用跑在 3001 —— 两者互不干扰，可以边跑边构建。
ssh "$SSH_HOST" bash -s <<REMOTE_BUILD
set -euo pipefail
cd '$REMOTE_DIR'

# 解包到 app 目录（保留上一步投递的 .env）
mkdir -p app
tar -xzf src.tar.gz -C app

cd app
echo "── 源码已就位，commit：\$(cat '$REMOTE_DIR/version.txt' | head -1 | cut -c1-8) ──"
echo "── Node \$(node -v) / npm \$(npm -v) ──"
echo

echo "── 安装依赖（npm ci，按 lockfile 精确安装）──"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
echo

echo "── 生产构建 ──"
# NEXT_DIST_DIR 不设置，用默认 .next（服务器上无并发 dev server，无污染风险）
FINBUDDY_ALLOW_BUILD_WITH_DEV=1 npm run build
echo

echo "── 重启服务 ──"
systemctl restart finbuddy
sleep 4
systemctl is-active finbuddy && echo "finbuddy 状态：active"
echo
echo "── 本地端口自检（应用端口 ${APP_PORT}）──"
for i in \$(seq 1 20); do
  if curl -sf --max-time 5 "http://127.0.0.1:$APP_PORT/" >/dev/null 2>&1; then
    echo "✓ 应用已在 127.0.0.1:$APP_PORT 响应"
    break
  fi
  if [ "\$i" = "20" ]; then
    echo "✖ 应用启动后 20 次探测均未响应，打印最近日志：" >&2
    journalctl -u finbuddy -n 40 --no-pager >&2
    exit 1
  fi
  sleep 3
done

echo
echo "── Nginx 反代自检 ──"
if curl -sf --max-time 5 "http://127.0.0.1/" >/dev/null 2>&1; then
  echo "✓ Nginx 80 端口反代正常"
else
  echo "⚠ Nginx 80 端口未正常反代，打印日志：" >&2
  tail -20 /var/log/nginx/finbuddy.error.log 2>/dev/null >&2 || true
fi
REMOTE_BUILD

ok "服务器构建与重启完成"

# ═══════════════════════════════════════════════════════════
# 阶段 7：部署后验证（自动，会真的失败）
# ═══════════════════════════════════════════════════════════
log "7/7 部署后验证"

PUBLIC_IP="$(ssh "$SSH_HOST" "curl -s --max-time 10 https://myip.ipip.net 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1" || true)"
if [ -z "$PUBLIC_IP" ]; then
  warn "未能自动获取公网 IP，请手动运行验证："
  echo "    node scripts/verify-deploy.mjs http://<你的公网IP>"
  PUBLIC_IP=""
fi

if [ -n "$PUBLIC_IP" ]; then
  URL="http://$PUBLIC_IP"
  echo "    目标：$URL"
  echo "    （脚本会发出真实提问，会消耗 DeepSeek/Fuyao/iFinD 额度）"
  echo

  if node scripts/verify-deploy.mjs "$URL"; then
    cat <<EOF

${GREEN}════════════════════════════════════════════════════════════
 ✓ 部署成功且验证通过（4/4）
════════════════════════════════════════════════════════════${RESET}
 公网地址 : $URL
 运行 commit: ${DEPLOY_SHA:0:8}  ($(git log -1 --format=%s "$DEPLOY_SHA" | cut -c1-40))
 应用端口 : ${APP_PORT}（本机回环）→ Nginx:80（公网）

 常用运维命令（ssh $SSH_HOST 后执行）：
   journalctl -u finbuddy -f          # 跟随应用日志
   systemctl restart finbuddy         # 重启应用
   tail -f /var/log/nginx/finbuddy.access.log   # 访问日志
   free -m                            # 查看内存/swap

 提醒：这是 http:// + 纯 IP 的访问方式 —— 没有域名、没有 HTTPS，
 浏览器可能提示"不安全"。这是未备案的必然结果（备案按域名绑定）。
 演示时建议说明这一点。
EOF
  else
    cat <<EOF

${RED}════════════════════════════════════════════════════════════
 ✖ 部署完成，但验证未全部通过
════════════════════════════════════════════════════════════${RESET}
 代码已经部署、服务已经起来，但上面有项目未通过。
 请按脚本给出的提示排查，**不要**把这次部署记为"已验证通过"。

 最可能的两项：
   · 第 2 项（5 个 data part）失败 → 多为密钥问题或模型余额耗尽
     （历史故障：DeepSeek 余额为 0 时，所有提问会被 fail-closed 拦下）
   · 第 4 项（SSE 未缓冲）失败 → 检查 /etc/nginx/conf.d/finbuddy.conf
     的 proxy_buffering off 是否生效，然后 systemctl reload nginx

 服务其实已经可用，可先手动打开 $URL 看是否为"一直转圈不输出"。
EOF
    exit 1
  fi
fi
