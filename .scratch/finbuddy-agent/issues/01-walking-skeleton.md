# 01: 行走骨架——流式会话 + 首个真实工具调用

**What to build:** 用户打开页面，输入"中际旭创现在什么价"，前端以流式方式看到 AI 的思考过程、一次真实的扶摇行情工具调用（含调用参数与返回摘要），并给出基于真实数据的回答。这一票打通「Next.js 14 + DeepSeek V4.1-Flash + 扶摇 MCP」的端到端技术链路，证明脚手架、模型 tool-calling、数据源接入三者真的联通。

**Blocked by:** None (可立即开始)

**Status:** done (2026-10-12，经双轴 code-review，修复 2 个真实缺陷)

- [x] Next.js 14 App Router + TypeScript + Tailwind 脚手架就绪，`npm run dev` 可启动
- [x] 环境变量从 `.env` 读取（DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、FUYAO_API_KEY、IFIND_MCP_KEY），服务端可访问
- [x] `/api/chat` 使用 Vercel AI SDK `streamText` + `deepseek-flash`（经 OpenAI 兼容 provider 指向 DeepSeek 官方端点），配置多步工具循环
- [x] 已定义一个真实工具 `lookupStockSnapshot`，调用扶摇 MCP `get_a_share_prices_snapshot`（thscode 形如 `300308.SZ`），返回真实行情
- [x] 用户输入中文标的名称（如"中际旭创"）能解析为 thscode（先用最小可行的解析，T2 再做完整标的检索）
- [x] 前端用 `useChat` 流式渲染 AI 文本与工具调用状态（工具名、入参、返回摘要）
- [x] 输入"中际旭创现在什么价"能返回真实价格与涨跌幅（可回溯到扶摇真实字段）
- [x] 页面不出现未捕获异常；模型/数据源任一出错有可见错误提示，不白屏

**验收方式（手工）:** `npm run dev` 后访问 localhost:3000，输入"中际旭创现在什么价"，看到流式输出 + 工具调用卡片 + 真实价格。

---

## 勾选说明（2026-10-13 补记）

本票在原开发时已实现并通过验证（见 Status），但当时漏勾复选框。2026-10-13
交付前逐项抽查后补勾，抽查依据：

- T1：`app/api/chat/route.ts` 含 `streamText` + `stopWhen`（多步循环）；
  `app/page.tsx` 用 `useChat`；
- T2：三个工具均在 `route.ts` 中注册；`lib/financials.ts` 的 `sumTTM` 做 TTM 年化；
  `lib/ifind.ts` 有 `initialize` → `Mcp-Session-Id` 的 session 管理，
  并以结构化 `IfindError`（timeout/http/auth/business/shape）返回错误，
  而非静默失败（本票要求"返回结构化错误"，未字面使用 `4001`/`429`
  是因为错误在网关层被归一化为语义类别）。

**未重新做真机回归**：本票的真机验证发生在 2026-10-12，此后代码有演进
（T3-T5）。当前 DeepSeek 余额耗尽，真机集成测试处于 skipped 状态，
因此本票的"真机通过"结论属于**当时有效**，未在本日重新确认。
