# 01: 行走骨架——流式会话 + 首个真实工具调用

**What to build:** 用户打开页面，输入"中际旭创现在什么价"，前端以流式方式看到 AI 的思考过程、一次真实的扶摇行情工具调用（含调用参数与返回摘要），并给出基于真实数据的回答。这一票打通「Next.js 14 + DeepSeek V4.1-Flash + 扶摇 MCP」的端到端技术链路，证明脚手架、模型 tool-calling、数据源接入三者真的联通。

**Blocked by:** None (可立即开始)

**Status:** done (2026-10-12，经双轴 code-review，修复 2 个真实缺陷)

- [ ] Next.js 14 App Router + TypeScript + Tailwind 脚手架就绪，`npm run dev` 可启动
- [ ] 环境变量从 `.env` 读取（DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、FUYAO_API_KEY、IFIND_MCP_KEY），服务端可访问
- [ ] `/api/chat` 使用 Vercel AI SDK `streamText` + `deepseek-flash`（经 OpenAI 兼容 provider 指向 DeepSeek 官方端点），配置多步工具循环
- [ ] 已定义一个真实工具 `lookupStockSnapshot`，调用扶摇 MCP `get_a_share_prices_snapshot`（thscode 形如 `300308.SZ`），返回真实行情
- [ ] 用户输入中文标的名称（如"中际旭创"）能解析为 thscode（先用最小可行的解析，T2 再做完整标的检索）
- [ ] 前端用 `useChat` 流式渲染 AI 文本与工具调用状态（工具名、入参、返回摘要）
- [ ] 输入"中际旭创现在什么价"能返回真实价格与涨跌幅（可回溯到扶摇真实字段）
- [ ] 页面不出现未捕获异常；模型/数据源任一出错有可见错误提示，不白屏

**验收方式（手工）:** `npm run dev` 后访问 localhost:3000，输入"中际旭创现在什么价"，看到流式输出 + 工具调用卡片 + 真实价格。
