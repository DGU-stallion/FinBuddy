# FinBuddy 部署（阿里云轻量服务器 · 纯公网 IP 访问）

> 状态：**自动化脚本已就绪，尚未在这台服务器上实际执行过。**
> 按本仓库规则，未验证的事不写成已验证 —— 执行完 `deploy.sh` 后把它的验证输出贴到本文末尾。

---

## 1. 这套部署是什么

| 项 | 选择 | 原因 |
|---|---|---|
| 平台 | 阿里云轻量应用服务器 2C1G（中国大陆） | 已有资源；大陆节点免翻墙直连 |
| 访问方式 | `http://<公网IP>` | 不买域名、不备案 |
| 运行时 | systemd 跑 `next start`（端口 3001） | 系统自带，重启语义可靠 |
| 反向代理 | Nginx 80 → 127.0.0.1:3001 | **必须关闭 SSE 缓冲** |
| 自动化 | 本地 `./deploy/deploy.sh` 一键 | 无需在 GitHub 存密钥 |

### 为什么不用域名：备案的真相

备案**按域名绑定**，不按 IP。所以：

- 直接访问 `http://<IP>` → 没有 Host 域名可拦 → **不需要备案，可用**
- 任何"送你一个默认域名"的方案在大陆都会遇到三者之一：域名被墙 / 要求备案 / 过期预览链接

代价是 **没有 HTTPS**（公共 CA 不给裸 IP 签 DV 证书，自签必弹警告）。
已确认本项目不依赖安全上下文 API（无 clipboard / crypto / serviceWorker；`localStorage` 在 http 下正常），
所以 http 不影响功能，只是浏览器可能提示"不安全"。

**若日后要升级到域名**：需备案（阿里云初审 + 管局审核，通常数周）→ 服务器购买时长需 ≥3 个月才能申请备案服务号 →
然后加 443 配置与证书即可，Nginx 结构不用改。

---

## 2. 快速开始

### 前置：配好 SSH 免密

`~/.ssh/config` 加：

```sshconfig
Host finbuddy
    HostName <你的服务器公网IP>
    User root
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

上传公钥：

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@<你的服务器公网IP>
ssh finbuddy 'echo 通了'
```

### 配置与部署

```bash
cp deploy/.env.deploy.example deploy/.env.deploy
$EDITOR deploy/.env.deploy          # 填 FINBUDDY_SSH_HOST=finbuddy

./deploy/deploy.sh --check          # 先干跑预检（不上传、不部署）
./deploy/deploy.sh                  # 正式部署
```

**首次部署前必须在阿里云控制台确认防火墙放行了 HTTP(80)** —— 那个防火墙独立于系统防火墙，
脚本改不了它，被拦时表现为浏览器超时。

想钉住某个版本（推荐，尤其在有并行开发时）：

```bash
./deploy/deploy.sh b90bb65
```

---

## 3. 两个关键设计决策

### 为什么是 3001 而不是 3000

`scripts/check-safe-build.mjs` 会探测 **3000** 端口，若有服务占用就**拒绝构建**
（这是为拦截"dev server 运行时构建污染 `.next/`"那个已发生两次的事故而写的守卫）。

如果应用部署在 3000，那么服务器上跑 `npm run build` 时，**守卫会拒绝自己**，
部署脚本会莫名其妙地失败。把应用放 3001 后，两者互不干扰，守卫保持原样有效。

> 这个坑不显眼但一定会踩到：报错信息说的是一回事（"检测到 dev server 在跑"），
> 实际情况是另一回事（根本没有 dev server，是自己占的端口）。

### 为什么上传包要排除 `tmp/`

仓库里 `tmp/iso-probe/` 是一次 Next 构建产物被**误提交**（commit `e1c4713`），
占 **162MB / 178 个文件**；`.gitignore` 只覆盖了 `tmp/shots/`。

| | 包大小 | 文件数 |
|---|---|---|
| 不排除 | 26 MB | 384 |
| 排除后 | **476 KB** | **151** |

`deploy.sh` 用 `git archive <sha> -- . ':(exclude)tmp'` 排除。

> ⚠️ **这是一个真实的仓库卫生问题，尚未修复**：163MB 的构建产物躺在 git 历史里，
> 每次 clone 都要拉。建议单独处理：`git rm -r --cached tmp/iso-probe` 并补 `.gitignore`。

---

## 4. SSE 必须关闭缓冲（这类应用最典型的部署故障）

Nginx 默认 `proxy_buffering on`，会把整个响应攒完再一次性发给浏览器。
对本项目的表现是：**功能全对，但用户提问后一直转圈，最后一次性刷出全部内容**。
很容易被误判成"模型慢"而去优化模型。

`deploy/nginx.conf` 的关键四项：

```nginx
proxy_buffering off;              # 最关键
proxy_cache off;
proxy_read_timeout 300s;          # 一次问答含多步工具循环，实测 30–52s
proxy_http_version 1.1;           # SSE 需要 1.1
proxy_set_header Connection '';   # 保持长连接不被改写成 close
```

`scripts/verify-deploy.mjs` 的第 4 项专门抓这个，双判据、且用**故意缓冲的代理**反例验证过有牙：

| 形态 | 首字节占比 | chunk 到达跨度 | 判定 |
|---|---|---|---|
| 未缓冲 | 28% | 37373ms | ✅ |
| 已缓冲 | 100% | 1ms | ❌ |

---

## 5. 验证（不要跳过）

`deploy.sh` 最后一步会自动跑，也可以手动：

```bash
node scripts/verify-deploy.mjs http://<公网IP>
```

四项：① 首页可访问**且确实是我们的页面** ② 5 个 data part 齐全
③ 合规路径拦截且未漏出三栏 ④ **SSE 未缓冲**

只有 4/4 通过，`deploy.sh` 才返回 0。**未通过时不要记为"部署成功"。**

### 排查：第 2 项失败通常是余额，不是代码

历史故障记录：DeepSeek 余额耗尽（¥0.04）时，**所有**提问被 fail-closed 拦下，
文案含"合规校验服务暂时不可用"。此时先查 `/user/balance`，
不要怀疑代码 —— 可用 `data-compliance.layer === 'fail_closed'` 机器识别。

---

## 6. 运维命令

```bash
ssh finbuddy

journalctl -u finbuddy -f                      # 应用日志
systemctl restart finbuddy                     # 重启应用
systemctl status finbuddy                      # 状态
tail -f /var/log/nginx/finbuddy.access.log     # 访问日志
nginx -t && systemctl reload nginx             # 改完 Nginx 配置后
free -m                                        # 内存 / swap
cat /opt/finbuddy/version.txt                  # 线上跑的是哪个 commit
```

---

## 7. 为什么没用这些方案（均有实测依据）

从大陆网络实测（本机出口 IP `223.160.189.89`，中国四川移动）：

| 域名 | 结果 | 说明 |
|---|---|---|
| `vercel.app` | ❌ 连接失败 | **DNS 污染**（本机 DNS 与 `1.1.1.1` 结果不一致） |
| `workers.dev` | ❌ 连接失败 | **DNS 污染**（被劫持到 `31.13.x`） |
| `edgeone.app` | ❌ 8s 超时 | 不通 |
| `zeabur.app` | ⚠️ 404 可达 | 但默认节点在 AWS `us-west-1` |

**Cloudflare Tunnel / 各类内网穿透：实测会缓冲 SSE，直接排除。**

我起了一个 HTTP/1.1 chunked 的 Node SSE 服务做对照（与 Next.js 行为一致）：

| 路径 | chunk 到达（每块间隔 600ms，共 8 块） | 结论 |
|---|---|---|
| 本地直连 | `0.648s → 4.861s` 逐块到达 | 基线正确 |
| 经 Quick Tunnel | **`6.292s → 6.412s`**，8 块挤在 44ms 内 | **全部攒完才发 → 被缓冲** |

这不是 HTTP/1.0 的锅：首次用 Python `http.server`（HTTP/1.0）测出缓冲后，
我换成带 `text/event-stream` + `X-Accel-Buffering: no` 的 HTTP/1.1 chunked 服务器重测，
**依然缓冲**。对用户的表现就是"转圈 6 秒然后一次刷出"。

其他平台排除理由：

- **阿里云函数计算 FC**：官方文档明说"对外提供网站类型服务**只能通过已备案域名**"；
  默认 `*.fcapp.run` 仅测试用，浏览器访问会**强制下载**；且内置运行时不支持流式（需 Web 函数/自定义镜像）。
- **腾讯云 EdgeOne Pages**：支持 Next.js 14 + 流式，但默认域名在大陆需用**3 小时有效期的预览链接**（过期 401）。
- **腾讯云 CloudBase / 微信云托管**：需备案域名；2025-10 起默认域名还会对非导航请求加 `Content-Disposition: attachment`。
- **Zeabur**：`zeabur.app` 默认解析到美国 AWS；其"预备案子域名"功能要求服务器是从 Zeabur 购买的。
- **Hugging Face Spaces**：`hf.space` 在大陆已被屏蔽。

---

## 8. 部署记录

> **部署完成后填写。** 按仓库规则，没跑过就不写。

```
（待填）部署时间：
（待填）commit：
（待填）公网 URL：
（待填）node scripts/verify-deploy.mjs 输出：
```

- [ ] 阿里云控制台已放行 HTTP(80)
- [ ] `./deploy/deploy.sh --check` 预检通过
- [ ] `./deploy/deploy.sh` 执行完成
- [ ] **`verify-deploy.mjs` 4/4 通过**
- [ ] 浏览器人工确认流式输出是逐字出现（而非一次性刷出）
