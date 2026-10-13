# 部署说明

> **状态：代码已具备部署条件，且 GitHub 仓库已上线；尚未部署到公开 URL。**
> 本文是**照做清单**——按顺序执行即可，最后一条命令自动完成全部验证。
> 未部署的事实如实记录在文末「当前状态」，不预写"已部署"。

---

## 0. 已就绪（无需你操作）

| 项 | 状态 | 证据 |
|---|---|---|
| 代码可构建 | ✅ | `npm run build` → Compiled successfully |
| GitHub 仓库（公开） | ✅ | https://github.com/DGU-stallion/FinBuddy |
| 全新克隆可自包含运行 | ✅ | 无 `.env` 时 `0 failed`；真机测试显式 `ctx.skip()` 并打印原因（不当成通过） |
| 密钥未入库 | ✅ | 全历史扫描：3 个真实密钥 0 次出现；仅 `.env.example`（空模板）被跟踪 |
| `vercel.json` / `.env.example` | ✅ | 已就绪（选国内平台时 `vercel.json` 可删） |
| 部署后验证脚本 | ✅ | `scripts/verify-deploy.mjs`（已实测有牙：见第 3 节） |

**你只需要做两件事**：① 选平台并配置 4 个环境变量；② 部署完跑一条验证命令。

---

## 1. 唯一需要你决定的事：平台选择

原题要求「**国内免翻墙直连可访问**」。这与 Vercel 默认域名存在冲突：

| 平台 | 部署难度 | 国内直连 | 说明 |
|---|---|---|---|
| Vercel（`*.vercel.app`） | 最低 | **通常不可用** | 默认域名在国内多被阻断。要满足原题需绑定自有域名 + ICP 备案 |
| 阿里云 SAE / 函数计算 | 中 | ✅ | 需实名 + 备案域名；函数计算注意 SSE 长连接配置 |
| 腾讯云 CloudBase / 轻量服务器 | 中 | ✅ | 同上 |
| 自有服务器 + Nginx | 中 | ✅ | **务必** `proxy_buffering off`，否则 SSE 被缓冲 |

**建议**：若你已有备案域名 → 走国内云（严格满足原题）；
若只想先有个能打开的链接 → 走 Vercel，但**要在演示时说明**默认域名的访问限制。

---

## 2. 配置环境变量（两条路径通用）

4 个变量（完整说明见 `.env.example`）：

| 变量 | 必需 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 主推理模型 |
| `DEEPSEEK_BASE_URL` | 否 | 留空用官方 `https://api.deepseek.com` |
| `FUYAO_API_KEY` | 是 | 扶摇：行情 / 估值 / 财务报表 |
| `IFIND_MCP_KEY` | 是 | iFinD：公告与新闻检索 |

真实值在本地 `.env` 里（该文件**不入库**，已验证）。复制到平台的环境变量配置即可。

> ⚠️ 不要用 `BASE_URL` 作变量名 —— Vite 会把它设成 `/`，导致探活失败。
> 本仓库用 `DEEPSEEK_BASE_URL` 与 `FINBUDDY_BASE_URL` 两个不同名字，各有用途。

---

## 3. 部署后验证（一条命令，**别跳过**）

```bash
node scripts/verify-deploy.mjs https://你的域名
```

它会验证 4 件事并给出**可执行的修法**：

1. 首页可访问**且确实是我们的页面**（不只看状态码 —— 避免把平台占位页当成功）
2. 预置案例走完整链路（5 个 data part：`steps / plan / refs / contract / followups` 齐全）
3. 合规路径确实拦截，且**未漏出三栏分析**
4. **SSE 流式未被缓冲** ← 最容易被忽略的一项

### 第 4 项为什么单独列出来

这类应用最典型的部署故障是「**功能完全正确，但 SSE 被反向代理缓冲**」——
浏览器里表现为"一直转圈不输出"，运维很容易误判成"模型慢"而去优化模型。

本脚本用双判据识别缓冲。**判据已实测有牙**（不是拍脑袋的阈值）：

| 部署形态 | 首字节占比 | chunk 到达跨度 | 判定 |
|---|---|---|---|
| 直连开发服务器（未缓冲） | 28% | 37373ms | ✅ 通过 |
| 故意缓冲的代理（全收完再发） | **100%** | **1ms** | ❌ 正确失败 |

验证方式：我写了一个把所有响应攒完再一次性发出的代理（等价于 Nginx 默认
`proxy_buffering on`），脚本准确报出「所有 chunk 几乎同时到达 —— SSE 被缓冲」。
**分离度 28% vs 100%、37373ms vs 1ms**，不存在阈值临界问题。

也确认了它会对死掉的地址正确报 4/4 失败（不会假绿）。

### 若第 4 项失败

Nginx 配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;          # ← 关键
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;       # SSE 需要 1.1
}
```

---

## 4. 路径 A：Vercel

```bash
npm i -g vercel
vercel login                              # 浏览器授权（人工步骤）
vercel                                    # 首次：创建项目（预览）
vercel env add DEEPSEEK_API_KEY           # 逐个添加 4 个变量
vercel env add FUYAO_API_KEY
vercel env add IFIND_MCP_KEY
vercel --prod                             # 生产部署
```

`vercel.json` 已配好：

- `framework: nextjs`
- `regions: ["hkg1"]`（香港，离大陆最近）
- `functions["app/api/chat/route.ts"].maxDuration: 60`

> **`maxDuration: 60` 是必需的，不是优化项。** 一次问答含计划调用 + 最多 5 步工具
> 循环，本机实测单轮约 30–52s。Vercel 默认函数超时（10s）会在流中途切断，
> 表现为"回答写到一半停住"。

部署完执行第 3 节的验证命令。

---

## 5. 路径 B：国内云 / 自有服务器

```bash
npm ci
npm run build
PORT=3000 npm run start
```

前面必须挂 Nginx 并按第 3 节的配置**关闭缓冲**。

---

## 6. 部署检查清单

- [ ] 平台已确定（严格满足原题 → 需国内云 + 备案域名）
- [ ] 4 个环境变量已在平台配置
- [ ] `npm run build` 本地通过（已验证 ✅）
- [ ] **部署后 `node scripts/verify-deploy.mjs <URL>` 4/4 通过**
- [ ] `maxDuration` ≥ 60s（Vercel 路径）
- [ ] 复核 `.env` 未入库（`git ls-files | grep '^\.env'` → 应只见 `.env.example`）
- [ ] 把验证输出抄到下方「部署记录」（**部署完成后**再填）

---

## 7. 部署记录

> 部署完成后填写。脚本输出的 4/4 结果直接粘在下面即可 —— 这是原题要求的
> "AI 使用与验证记录"的一部分。

```
（待填）部署时间：
（待填）平台 / URL：
（待填）node scripts/verify-deploy.mjs 输出：
```

---

## 8. 当前状态（诚实标注）

- [x] 代码可构建（`npm run build` → Compiled successfully）
- [x] GitHub 公开仓库已上线并验证可匿名克隆
- [x] 全新克隆无 `.env` 时 0 failed（跳过项全部显式带原因）
- [x] 密钥全历史扫描通过
- [x] `.env.example` / `vercel.json` / 验证脚本就绪
- [x] 验证脚本的判据经对照实验确认有效（含故意缓冲的反例）
- [x] **真机端到端已跑通**：557 passed / **0 skipped**；合规测试集 6/6 exit 0
- [ ] **未实际部署**（需账户授权，属人工步骤）
- [ ] 未产生公开 URL
- [ ] 未做部署后验证

> 最后三项在部署完成前保持未勾选。**跳过不等于通过** —— 不预先勾选，
> 也不把"本地验证通过"写成"部署验证通过"。
