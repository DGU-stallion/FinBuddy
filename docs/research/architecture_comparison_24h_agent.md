# 24小时极速构建 AI 投资研究助手架构方案对比

本文针对**FinBuddy**（个人投研助理智能体）在 24 小时极限开发周期内的技术选型，对两种主流技术方案进行全方位调研与对比：
- **方案 A (Python Stack)**：FastAPI + LangChain / LangGraph + React 前端 + Railway / Zeabur 部署
- **方案 B (Next.js Fullstack)**：Next.js App Router + Vercel AI SDK + Vercel 免费托管部署

---

## 一、业务场景与核心流程拆解

产品核心业务流：
1. **意图理解与论题拆解**：接收用户自然语言投资观点（如：“宁德时代在固态电池量产后市占率将大幅下滑”），拆解为 2~4 个可验证的财务/行情/资讯子命题。
2. **多工具调用（Function Calling / MCP）**：
   - 同花顺扶摇平台 (`fuyao.aicubes.cn`) 提供了托管的 MCP 接口（如 `https://fuyao.aicubes.cn/mcp/a-share`、`fuyao-meta` 等）以及标准 REST API。
   - Agent 需自主选择调用标的查询、行情快照、历史财报数据或研报资讯。
3. **多步逻辑推理与证据链合成**：综合检索数据，归纳为支撑证据（Supporting）、反驳证据（Opposing）与不可证伪/不确定项（Unverifiable）。
4. **流式输出**：前端以打字机或步骤条形式流式展示 Agent 思考过程（Thought/Plan）、工具调用状态（Tool Calling / Args / Output）及最终结论（Synthesis）。

---

## 二、核心技术维度深度对比

### 1. 工具调用（Tool / Function Calling）机制

| 维度 | 方案 A: FastAPI + LangChain/LangGraph | 方案 B: Next.js + Vercel AI SDK |
| :--- | :--- | :--- |
| **工具定义机制** | `@tool` 装饰器搭配 Pydantic 模型；或自定义 BaseTool 类。原生支持 Python 复杂类型。 | `tool({ description, parameters: z.object({...}), execute })` 基于 Zod 强校验。 |
| **同花顺 MCP 对接** | Python 社区有官方 `mcp` SDK；但将 MCP 动态映射到 LangGraph 节点需要编写适配胶水代码（约 50~100 行），或直接用 `httpx` 调用扶摇的 REST API。 | 原生支持 `@ai-sdk/mcp` 包：<br>`const mcpClient = await createMCPClient({ transport: { type: 'http', url: 'https://fuyao.aicubes.cn/mcp/a-share', headers: { 'X-api-key': key } } })`<br>可直接通过 `await mcpClient.tools()` 将工具灌入 LLM，生态支持最直接。 |
| **多步 Agent 循环** | LangGraph 采用 StateGraph（状态图）机制，定义 `agent` 节点与 `tools` 节点，通过条件边循环，控制粒度极强，但概念较重。 | Vercel AI SDK 5/6 原生内置 agent 循环机制，仅需在 `streamText` 中设置 `stopWhen: isStepCount(5)`，底层自动执行 `execute` 并回传结果进入下一轮思考。 |
| **上手门槛** | 中等偏高（需理解 LangGraph 的 State、Memory、Checkpoint 概念）。 | 极低（声明式参数，开箱即用）。 |

---

### 2. 流式响应（Streaming & 思考过程可视化）

| 维度 | 方案 A: Python + FastAPI + React | 方案 B: Next.js + Vercel AI SDK |
| :--- | :--- | :--- |
| **流式协议** | `StreamingResponse(sse_generator(), media_type="text/event-stream")`。需要手动设计数据包协议格式（如 `type: "thinking" | "tool_call" | "token"`）。 | Vercel Data Stream Protocol（内置规范化数据流）。 |
| **前后端握手** | 前端需自己用 `fetch` + `ReadableStreamDefaultReader` 或 `EventSource` 解析 chunk 并管理 React 状态，极易踩解析与刷新重绘的坑。 | 前端只需调用 `@ai-sdk/react` 的 `useChat()`：<br>`const { messages } = useChat()`<br>消息包含 `part.type === 'tool-invocation'` 与 `part.type === 'text'`，无需手动解析任何流式协议。 |
| **Thinking 过程展示** | 需要在 LangGraph 的事件流中过滤 `on_chat_model_stream` 与 `on_tool_start` 并打包推送。 | 支持 DeepSeek Reasoner 的 thinking 标签捕获，以及多步骤中 tool 执行阶段（`call` / `result`）的自动状态转换展示。 |

---

### 3. 本地开发端点适配（Magpie / DeepSeek v4.1 Flash 本地模型）

* **本地推演服务端假设**：Magpie 作为一个本地推理服务，通常暴露标准 OpenAI 兼容的 HTTP API（默认形如 `http://localhost:8000/v1` 或 `http://127.0.0.1:11434/v1`）。

- **方案 A (Python)**：
  ```python
  from langchain_openai import ChatOpenAI
  llm = ChatOpenAI(
      base_url=os.getenv("LOCAL_LLM_URL", "http://localhost:8000/v1"),
      api_key=os.getenv("LOCAL_LLM_KEY", "EMPTY"),
      model="deepseek-v4.1-flash"
  )
  ```
- **方案 B (Next.js / AI SDK)**：
  ```typescript
  import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
  
  const magpie = createOpenAICompatible({
      name: 'magpie',
      baseURL: process.env.MAGPIE_BASE_URL || 'http://localhost:8000/v1',
      apiKey: process.env.MAGPIE_API_KEY || 'dummy-key',
  });
  const model = magpie(process.env.MODEL_NAME || 'deepseek-v4.1-flash');
  ```
* **结论**：两者在本地端点对接上均非常平滑，只需配置 `baseURL` 与 `apiKey`。

---

### 4. 生产环境切换至 DeepSeek 官方 API

- **方案 A (Python)**：
  只需修改环境变量：
  `OPENAI_API_BASE=https://api.deepseek.com/v1`
  `OPENAI_API_KEY=sk-xxxx`
  `MODEL=deepseek-chat` (或 `deepseek-reasoner`)
- **方案 B (Next.js / AI SDK)**：
  AI SDK 官方提供了 `@ai-sdk/deepseek`，或者直接复用 `@ai-sdk/openai-compatible`。
  切换只需一行代码或条件判断：
  ```typescript
  import { createDeepSeek } from '@ai-sdk/deepseek';
  const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
  const model = process.env.NODE_ENV === 'production' 
      ? deepseek('deepseek-chat') 
      : magpie('deepseek-v4.1-flash');
  ```
* **结论**：两者切换难度一致，均能通过单一环境变量控制。

---

### 5. 部署复杂度与免费额度（Railway / Zeabur vs Vercel）

| 维度 | 方案 A: FastAPI + React (Railway / Zeabur) | 方案 B: Next.js (Vercel) |
| :--- | :--- | :--- |
| **仓库与工程结构** | 通常为前后端分离 Monorepo 或两个独立仓库。需维护 `requirements.txt` / `Dockerfile` 及前端 `package.json`。 | 单一 Next.js 代码库（单一 `package.json`），类型全栈共享。 |
| **部署流程** | 需配置两个服务（前端 SPA 静态托管 + 后端 Python 容器运行时）。需解决 CORS 跨域问题。 | Git push 自动触发，0 配置，无跨域问题。 |
| **免费额度现状** | **Railway**：目前已取消永久免费层（仅给试用额度，耗尽后关机）。<br>**Zeabur**：免费层额度有限，且有冷启动或网络限制。<br>**Render / Koyeb / Fly.io**：有免费层，但冷启动延迟高（30~60秒）。 | **Vercel Hobby Tier**：永久免费，包含边缘 CDN、Next.js SSR/API 路由。 |
| **关键风险点** | Python 长驻服务需注意内存泄漏与连接管理。 | **Serverless 超时限制**：Vercel Hobby 免费层函数超时上限为 **60 秒**（需设置 `export const maxDuration = 60`）。金融 Agent 若多步调用耗时超过 60 秒会导致 504 错误。 |

---

### 6. 24 小时极限交付工时预估（Solo Dev + AI 编程助手）

| 模块 | 方案 A (Python + React) | 方案 B (Next.js + Vercel AI SDK) | 差异原因 |
| :--- | :--- | :--- | :--- |
| **工程初始化与配置** | 2.5 小时 | 1.0 小时 | Next.js 一键脚手架，无需配置 CORS、代理与两个环境。 |
| **数据源与 MCP 集成** | 3.5 小时 | 2.5 小时 | Vercel AI SDK 有现成 `@ai-sdk/mcp`，扶摇原生支持 HTTP MCP。 |
| **Agent 推理与编排** | 5.0 小时 | 3.0 小时 | LangGraph 需调试 State 流转与 checkpoint；AI SDK `streamText` + `stopWhen` 代码量少 60%。 |
| **前端流式与交互还原** | 6.0 小时 | 2.5 小时 | 方案 A 必须手写 SSE 协议与 React 状态解析；方案 B `useChat` 开箱即用支持工具渲染。 |
| **本地/线上模型联调** | 2.0 小时 | 1.5 小时 | 基本相当。 |
| **部署与上线排错** | 3.5 小时 | 1.0 小时 | Vercel 一键完成，无 Dockerfile、跨域或多服务环境变量同步问题。 |
| **总计预估时间** | **22.5 小时 (风险极高，容错率低)** | **11.5 小时 (从容，有充裕时间打磨 UI/Prompt)** | 方案 B 省略了大量管道代码（Plumbing Code）。 |

---

## 三、深度技术评估：Vercel AI SDK 构建 Agent 的核心能力

1. **多步工具调用（Multi-Step Loops）**：
   - 过去 AI SDK 需配合 LangChain，但在 AI SDK 3.x+ 及 5/6 版本中，`streamText` 引入了 `stopWhen`（或老版本的 `maxSteps`）。
   - 只要模型触发 `toolCall`，SDK 会自动在服务端触发 `tool.execute()`，并将返回值打包进 `tool-result`，再度传回模型，直到达成终止条件或模型决定输出文本。完全具备单 Agent 多步循环核心能力。
2. **原生 MCP 支持**：
   - `@ai-sdk/mcp` 提供了 `createMCPClient({ transport: { type: 'http', url: ... } })`。由于同花顺扶摇平台官方提供了标准 HTTP MCP (`https://fuyao.aicubes.cn/mcp/a-share`)，Next.js 可以直接零胶水挂载扶摇 MCP 工具。
3. **对话历史管理与数据持久化**：
   - 前端 `useChat` 自动维护本地会话历史；如果需要持久化，可在后端 `onFinish` 回调中异步将消息落库（如 Supabase / KV / SQLite）。
4. **Vercel 超时应对方案（针对 60s 免费层限制）**：
   - 投研任务若查询 3~4 个指标，总耗时可能达到 15~30 秒，完全在 60 秒上限内。
   - 必须在 API Route 顶部显式添加：`export const maxDuration = 60;`。
   - 建议限制子命题拆解数量（如最多 3 个），防止极端长链推理导致请求截断。

---

## 四、最终选型决策与权衡建议

### 结论：强烈推荐【方案 B：Next.js + Vercel AI SDK】

#### 推荐理由（24 小时交付导向）：
1. **去管道化（Eliminate Plumbing）**：`useChat` + `streamText` 抹平了前后端流式数据通信的所有脏活（SSE 格式解析、重试、工具状态流转）。
2. **同花顺 MCP 零成本集成**：利用 `@ai-sdk/mcp` 可以极快接驳扶摇的金融工具。
3. **零跨域与单点部署**：全栈 Monorepo 部署在 Vercel 免费层，免除 Docker 编排、多仓库同步与跨域头调试。
4. **交付确定性高**：预计耗时仅 ~12 小时，为 Prompt 调优、金融指标校验留下了充分缓冲时间。

#### 方案 B 的潜在权衡与防御性设计：
- **权衡点 1：函数 60 秒超时**。
  - *防御措施*：设置 `maxDuration = 60`；工具调用时并发查询多个指标（如通过 `Promise.all`）；提示词中限制 Agent 最多追问 2 轮。
- **权衡点 2：极其复杂的有向无环图（DAG）或多智能体博弈（Multi-Agent）**。
  - *应对方案*：24 小时 MVP 投研助手属于典型的“单 Agent + 多工具 + 结构化总结”范式，无需引入 LangGraph 复杂的图状态机，AI SDK 的顺序多步执行完全胜任。
