# 部署说明

> **状态：代码已具备部署条件，但尚未实际部署上线。**
> 本文给出步骤，并把需要人工决定/授权的事项显式列出，不预写"已部署"。

---

## ⚠️ 需要先决定的一件事：平台选择

原题要求交付「**国内免翻墙直连可访问的公开 Web URL**」。这与最常见的
Vercel 默认域名存在冲突：

| 平台 | 部署难度 | 国内直连 | 说明 |
|---|---|---|---|
| Vercel（`*.vercel.app`） | 最低 | **通常不可用** | 默认域名在国内多被阻断/不稳定，需绑定自有域名 + 备案；免费层函数超时上限 60s |
| 阿里云 SAE / 函数计算 | 中 | ✅ | 需实名与备案域名；函数计算需注意 SSE 长连接配置 |
| 腾讯云 CloudBase / 轻量服务器 | 中 | ✅ | 同上 |
| 自有服务器 + Nginx（反代 SSE） | 中 | ✅ | 需注意 `proxy_buffering off`，否则 SSE 会被缓冲 |

**结论**：若必须严格满足"国内免翻墙直连"，**不要用 Vercel 的默认域名**，
应选国内云厂商并绑定备案域名。这是一个交付决策，需要在部署前确定。

本文下方的 `vercel.json` 只是把 Vercel 路径准备好；选国内平台时该文件可删除。

---

## 通用前置：环境变量

部署平台需要配置 4 个环境变量（见 `.env.example`）：

| 变量 | 必需 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 主推理模型 |
| `DEEPSEEK_BASE_URL` | 否 | 留空用官方地址 |
| `FUYAO_API_KEY` | 是 | 扶摇：行情/估值/财务报表 |
| `IFIND_MCP_KEY` | 是 | iFinD：公告与新闻检索 |

**安全注意**：这些 key 只配在部署平台的环境变量里，绝不入库。
`.env` 已被 `.gitignore` 忽略，可用 `git ls-files | grep '^\.env'` 复核（应无输出）。

---

## 路径 A：Vercel

```bash
npm i -g vercel
vercel login            # 需要浏览器授权（人工步骤）
vercel                  # 首次：创建项目（预览部署）
vercel env add DEEPSEEK_API_KEY       # 逐个添加 4 个变量，或直接在 Dashboard 配
vercel env add FUYAO_API_KEY
vercel env add IFIND_MCP_KEY
vercel --prod           # 生产部署
```

`vercel.json` 已配置：
- `framework: nextjs`
- `functions["app/api/chat/route.ts"].maxDuration: 60`（**必需**：一次问答含
  计划调用 + 最多 5 步工具循环，实测单轮约 30s，默认超时会中断流）

**中国大陆访问**：需在 Dashboard 绑定自有域名，并在国内完成 ICP 备案。
仅 `*.vercel.app` 域名不满足题目"国内免翻墙直连"要求。

## 路径 B：国内云 / 自有服务器

```bash
# 构建
npm ci
npm run build

# 启动（注意 SSE 需要长连接）
PORT=3000 npm run start

# Nginx 反代关键配置（否则 SSE 被缓冲，前端表现为"一直转圈不出字"）
#   proxy_buffering off;
#   proxy_cache off;
#   proxy_read_timeout 300s;
#   proxy_set_header Connection '';
#   proxy_http_version 1.1;
```

务必确认反向代理**不缓冲** SSE。SSE 被缓冲是这类应用最常见的部署故障。

---

## 部署后必须验证的 4 件事

不要只看首页能打开就认为部署成功。按顺序验证：

```bash
BASE=https://<你的域名>

# 1) 首页可访问
curl -s -o /dev/null -w "%{http_code}\n" $BASE/           # 期望 200

# 2) 健康检查：预置案例的提问能走完整链路（应看到 5 个 data part）
curl -s -N -X POST $BASE/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"id":"u1","role":"user","parts":[{"type":"text","text":"中际旭创怎么样"}]}]}' \
  | grep -o 'data-[a-z]*' | sort | uniq -c
# 期望：data-contract / data-followups / data-plan / data-refs / data-steps 各 1

# 3) 合规路径可拦截（不应产出三栏）
curl -s -N -X POST $BASE/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"id":"u1","role":"user","parts":[{"type":"text","text":"请直接告诉我明天买入还是卖出"}]}]}' \
  | grep -c 'data-compliance'                              # 期望 ≥1
# 且输出中不应出现 【支持证据】

# 4) 流式未被缓冲：观察响应是否**逐步**到达，而非一次性吐出
curl -sN -X POST $BASE/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"id":"u1","role":"user","parts":[{"type":"text","text":"中际旭创怎么样"}]}]}' \
  | while IFS= read -r line; do echo "$(date +%S.%N | cut -c1-6) $line"; done | head -20
# 若所有行时间戳几乎相同 → SSE 被代理缓冲，需按路径 B 的 Nginx 配置修正
```

第 4 项尤其重要：**功能正确但被缓冲**的部署在浏览器里表现为"卡住不输出"，
很容易被误判为模型慢。

---

## 部署检查清单

- [ ] 确定平台（若严格要求国内直连 → 非 Vercel；见上方决策说明）
- [ ] 4 个环境变量已在平台配置
- [ ] `npm run build` 在本地通过（已验证：Compiled successfully）
- [ ] 部署后 4 项验证全部通过（尤其是第 4 项：SSE 未被缓冲）
- [ ] `maxDuration` ≥ 60s（Vercel 路径）
- [ ] 复核 `.env` 未入库
- [ ] 记录最终 URL 与验证输出，写回本文件（**部署完成后**再勾选）

---

## 当前状态（诚实标注）

- [x] 代码可构建（`npm run build` → Compiled successfully）
- [x] `.env.example` 与 `vercel.json` 就绪
- [x] 验证命令已写好（上方 4 项）
- [ ] **未实际部署**（需要账户授权，属人工步骤）
- [ ] 未产生公开 URL
- [ ] 未做部署后验证
