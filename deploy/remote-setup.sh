#!/usr/bin/env bash
#
# FinBuddy 服务器一次性初始化（幂等：可反复执行，不会重复生效）
#
# 由 deploy.sh 自动调用，一般不需要手动跑。手动执行：
#   scp deploy/remote-setup.sh <host>:/tmp/ && ssh <host> 'bash /tmp/remote-setup.sh'
#
# 做的事：
#   1. 2GB swap —— 1GB 内存跑 Next.js 生产构建大概率 OOM，没有 swap 会死在
#      "Running TypeScript" 或 "Collecting page data" 阶段，且报错很难懂
#   2. 安装 Node 20（NodeSource 源）
#   3. 安装 Nginx 并部署关闭缓冲的反代配置
#   4. 安装 systemd 单元
#   5. 放行防火墙端口
#
# 退出码：0 = 成功；非 0 = 失败（set -e 会在出错处停下并打印）
set -euo pipefail

APP_DIR="${FINBUDDY_REMOTE_DIR:-/opt/finbuddy}"
APP_PORT="${FINBUDDY_APP_PORT:-3001}"
SWAP_SIZE_GB="${FINBUDDY_SWAP_GB:-2}"

log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m⚠ %s\033[0m\n' "$*"; }

# ─────────────────────────────────────────────────────────────
# 0. 环境侦察（先看清底牌，避免在错误的机器上操作）
# ─────────────────────────────────────────────────────────────
log "0/5 环境侦察"
echo "  操作系统 : $(grep -E '^PRETTY_NAME' /etc/os-release | cut -d'"' -f2 2>/dev/null || echo unknown)"
echo "  架构     : $(uname -m)   ← 必须是 x86_64 或 aarch64"
echo "  内核     : $(uname -r)"
echo "  CPU 核心 : $(nproc)"
echo "  内存     : $(free -m | awk '/^Mem:/ {print $2" MB"}')"
echo "  磁盘可用 : $(df -h / | awk 'NR==2 {print $4}')"
echo "  出口公网 : $(curl -s --max-time 8 https://myip.ipip.net || echo '取不到')"
echo

if [ "$(nproc)" -lt 2 ]; then
  warn "检测到少于 2 核，构建会很慢但没有致命问题。"
fi

MEM_MB=$(free -m | awk '/^Mem:/ {print $2}')
if [ "$MEM_MB" -lt 1500 ]; then
  warn "内存仅 ${MEM_MB}MB —— 第 1 步的 swap 是本部署的关键，不要跳过。"
fi

# ─────────────────────────────────────────────────────────────
# 1. swap（构建内存安全网）
# ─────────────────────────────────────────────────────────────
log "1/5 配置 ${SWAP_SIZE_GB}GB swap"

if swapon --show 2>/dev/null | grep -q '/swapfile'; then
  ok "swapfile 已存在且已启用，跳过"
  swapon --show
else
  if [ -f /swapfile ]; then
    warn "/swapfile 已存在但未启用，尝试直接启用"
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  else
    echo "  创建 ${SWAP_SIZE_GB}GB swapfile（1GB 内存机器上约需 10–30 秒）..."
    # fallocate 在某些文件系统（如旧版 ext4/overlayfs）上会产出坏 swap，
    # 因此优先 dd，可靠优先于速度。
    if ! fallocate -l "${SWAP_SIZE_GB}G" /swapfile 2>/dev/null; then
      echo "  fallocate 不可用，改用 dd（较慢）..."
      dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_SIZE_GB * 1024)) status=none
    fi
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  fi

  # 持久化：否则重启后 swap 消失，构建又会 OOM
  if ! grep -q '^/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "已写入 /etc/fstab（重启后依然生效）"
  fi
fi

# 降低 swappiness 会让系统更倾向保留内存页、少用 swap；但构建这种瞬时峰值
# 恰恰需要 swap 顶上，所以这里保持默认值，只做说明不作调优。
echo "  当前 swap："
free -m | awk '/^Swap:/ {printf "    总计 %s MB，已用 %s MB\n", $2, $3}'

# ─────────────────────────────────────────────────────────────
# 2. Node 20
# ─────────────────────────────────────────────────────────────
log "2/5 安装 Node.js 20"

NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$CURRENT_MAJOR" -ge 18 ]; then
    ok "已有 Node $(node -v)，满足 Next.js 14 要求（>= 18.17）"
    NEED_NODE=0
  else
    warn "已有 Node $(node -v) 过旧，将安装 Node 20"
  fi
fi

if [ "$NEED_NODE" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs >/dev/null
  else
    echo "✖ 无法识别的包管理器，请手动安装 Node 20 后重跑" >&2
    exit 1
  fi
  ok "Node $(node -v) / npm $(npm -v) 安装完成"
fi

# ─────────────────────────────────────────────────────────────
# 3. Nginx + 反代配置
# ─────────────────────────────────────────────────────────────
log "3/5 安装 Nginx 并部署反代配置（关闭 SSE 缓冲）"

if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq nginx >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nginx >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nginx >/dev/null
  fi
  ok "Nginx 安装完成：$(nginx -v 2>&1)"
else
  ok "Nginx 已安装：$(nginx -v 2>&1)"
fi

mkdir -p "$APP_DIR/app"

# 配置由 deploy.sh 预先投递到 /tmp/nginx-finbuddy.conf
if [ -f /tmp/nginx-finbuddy.conf ]; then
  cp /tmp/nginx-finbuddy.conf /etc/nginx/conf.d/finbuddy.conf
  ok "已安装 /etc/nginx/conf.d/finbuddy.conf"
else
  warn "/tmp/nginx-finbuddy.conf 不存在 —— 跳过 Nginx 配置更新（首次部署请让 deploy.sh 投递）"
fi

# 校验配置语法：语法错就不要去 restart，避免把可能还活着的站点打挂。
# 注意：不能写成 `if nginx -t | tail -3` —— 管道的退出码是 tail 的，永远为 0，
# 会让语法检查形同虚设。先落盘再判退出码。
if nginx -t > /tmp/nginx-test.out 2>&1; then
  tail -3 /tmp/nginx-test.out
  ok "nginx -t 语法检查通过"
else
  cat /tmp/nginx-test.out >&2
  echo "✖ Nginx 配置语法错误，已中止。请检查 /etc/nginx/conf.d/finbuddy.conf" >&2
  exit 1
fi

# 关掉发行版默认站点，否则它可能抢占 80 端口的 default_server
if [ -f /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  ok "已移除发行版默认站点（避免抢占 80 default_server）"
fi

systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx
ok "Nginx 已重启并设为开机自启"

# ─────────────────────────────────────────────────────────────
# 4. systemd 单元
# ─────────────────────────────────────────────────────────────
log "4/5 安装 systemd 单元"

if [ -f /tmp/finbuddy.service ]; then
  # 把 npm 的**实际路径**写进单元文件。
  # 不能硬编码 /usr/bin/npm：NodeSource 装的是 /usr/bin/npm，但若机器上
  # 已有 nvm/其它安装，路径会不同，systemd 启动时会报 203/EXEC。
  NPM_BIN="$(command -v npm)"
  if [ -z "$NPM_BIN" ]; then
    echo "✖ 找不到 npm，无法生成 systemd 单元" >&2
    exit 1
  fi
  sed "s|^ExecStart=.*|ExecStart=${NPM_BIN} run start|" \
    /tmp/finbuddy.service > /etc/systemd/system/finbuddy.service
  systemctl daemon-reload
  systemctl enable finbuddy >/dev/null 2>&1 || true
  ok "已安装 /etc/systemd/system/finbuddy.service（ExecStart=${NPM_BIN}，应用端口 ${APP_PORT}）"
else
  warn "/tmp/finbuddy.service 不存在 —— 跳过（首次部署请让 deploy.sh 投递）"
fi

# ─────────────────────────────────────────────────────────────
# 5. 防火墙
# ─────────────────────────────────────────────────────────────
log "5/5 放行防火墙端口"

# 注意：阿里云轻量服务器的**控制台防火墙**（网页上那个）独立于系统防火墙，
# 脚本无法改动它 —— 首次部署必须在控制台手动放行 80。
# 这里只处理系统内的 firewalld / ufw，二者常被忽略。

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "firewalld 已放行 http(80)"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ok "ufw 已放行 80/tcp"
else
  echo "  未检测到活跃的 firewalld/ufw —— 系统防火墙层面无需处理"
fi

cat <<EOF

════════════════════════════════════════════════════════════
 服务器初始化完成
════════════════════════════════════════════════════════════
 应用目录 : ${APP_DIR}/app
 应用端口 : ${APP_PORT}（Nginx 反代到 80）
 Node     : $(node -v)
 内存/swap: $(free -m | awk '/^Mem:/ {print $2}')MB / $(free -m | awk '/^Swap:/ {print $2}')MB

 ⚠️ 还需要你手动做一件事（脚本改不了）：
    到阿里云控制台 → 轻量应用服务器 → 防火墙，
    确认已放行 **HTTP(80)**。轻量服务器默认就放行了 22/80/443，
    但如果之前被人改动过，这里会静默拦截，表现为浏览器超时。
════════════════════════════════════════════════════════════
EOF
