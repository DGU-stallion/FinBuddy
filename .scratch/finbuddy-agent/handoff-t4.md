# FinBuddy — Handoff（T3 完成 → T4 开始）

> **给下一个会话**。本文只记录**磁盘 artifacts 没有**的东西。开始前先读本文末尾「必读文件」，
> 不要重复读原题或重做已完成的分析。

---

## 1. 进度

| 票 | 内容 | 状态 |
|---|---|---|
| T1 | 行走骨架（流式 + 首个真实工具调用） | ✅ done |
| T2 | 三源金融网关 + 三级降级 + refId | ✅ done |
| T3 | Agent 分析契约（命题重构 + 三栏 + 追问） | ✅ **done**（含真机验证） |
| T4 | 问财式工作台前端 | ⬜ **下一步（frontier）** |
| T5 | 营收冲击推演引擎 + 预置案例 + 多轮上下文 | ⬜ blocked by T4 |

git：HEAD=`41f9b97` 之后有 1 个 docs commit；T3 共 4 个实质 commit（`6a0de41` → `c27fee0` → `9ddc824` → `41f9b97`）。

**T3 最终验证（真机，非推测）**：
- `npx vitest run` → **163 passed, 0 skipped**（T2 时 51）
- `npx tsc --noEmit` → 干净；`npm run build` → Compiled successfully
- `node scripts/compliance-suite.mjs` → **6/6, exit 0**
- `tests/agent-contract.integration.test.ts` → **2/2 通过**（真实 DeepSeek + 扶摇 + iFinD）

---

## 2. T3 建立的契约（T4 直接消费）

`app/api/chat/route.ts` 输出**单条 UI 消息流**，按序写 5 个 data part：

| part | 内容 | T4 用途 |
|---|---|---|
| `data-compliance` | `{layer: 'keyword'\|'intent'\|'fail_closed'}` | 仅拦截路径；`fail_closed` 必须与真拦截区分 |
| `data-steps` | `{steps:[{id,label,detail}]}` | 思考时间轴（确定性中文，**不要用模型推理**） |
| `data-plan` | `{reframedClaim,intentTags,subQuestions[],fromModel}` | 意图标签微调、命题展示 |
| `data-refs` | `{refs:[{refId,kind,payload}]}` | 存证抽屉数据源；`kind` ∈ snapshot/financials/announcements |
| `data-contract` | `{ok,violations[],citations{cited,valid,invalid,hasAny}}` | 角标灰标依据 |
| `data-followups` | `{questions:[3条]}` | 底部追问按钮 |

**关键顺序约束**：正文（`text-*`）**先** merge 进流，契约校验**后**跑。所以**编造的角标会到达前端** ——
按 ADR-0002 决策 2，**强制校验是 T4 前端的职责**（渲染灰色"引用失效"且不可点击）。
T3 只负责"报告"，不负责"拦截"。`lib/citations.ts` 是前后端共用的同一实现。

**可复用的 lib（T4 别重写）**：
- `lib/citations.ts` — `extractCitations` / `checkCitations`（角标校验）
- `lib/orchestration.ts` — `buildOrchestrationSteps`（时间轴）、`refKind`（抽屉分组）
- `lib/output-contract.ts` — `validateAnalysisOutput`、`REQUIRED_SECTIONS`
- `lib/vocabulary.ts` — 共享合规词表（单一事实来源）

---

## 3. 环境

- `.env`（不入 git）已填：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`FUYAO_API_KEY`、`IFIND_MCP_KEY`
- **DeepSeek 余额**：曾被耗尽（¥0.04）导致**所有**提问被 fail-closed 拦下；现余额 ¥1.98。
  若又出现"所有问题都被合规拦下"，**先查余额**（`/user/balance`），不要怀疑代码。
- dev server：`npx next dev`（端口 3000）。**本机有 http_proxy**，本地请求要用 `--noproxy '*'`
- 模型：`workbuddy/deepseek-v4.1-flash`（1M 上下文）
- **subagent**：本项目已在 `.pi/agents/{scout,worker}.md` 覆盖 `model: magpie/workbuddy/glm-5.3`。
  **必须用 pi 的 subagent 工具而不是裸 `pi` CLI**；裸 CLI 会走 OpenRouter 而 stalled（踩过）。
- 集成测试跑真机需 dev server 在跑；`FINBUDDY_BASE_URL` 覆盖地址（**不可叫 `BASE_URL`**，Vite 会占用它）

---

## 4. T4 要点与陷阱

1. **不要依赖模型推理做时间轴**：`data-steps` 已给确定性中文步骤。模型 thinking 倾向英文。
2. **角标校验必须前端强制**：`checkCitations(text, refIds)` → `invalid` 渲染灰标、不可点击。
3. **抽屉双层**：人类可读摘要默认显示，原始 JSON 可折叠（`payload` 直接用，不要转述）。
4. **降级指示灯**：`payload.isFallback === true` 时显著标注（`fallbackNote` 里有抓取日期）。
5. **标签微调交互**（spec 交互决策）：删除标签 → 自动重跑；改文本 → 需点确认才重跑（省 token）。
6. **多轮只带结构化结论摘要**，不带完整对话（spec 交互决策）。
7. 预置案例用 `listFallbackCases()`（中际旭创 / 宁德时代），别硬编码。

---

## 5. 踩过的坑（别再踩）

| 坑 | 症状 | 处理 |
|---|---|---|
| DeepSeek 余额耗尽 | **所有**提问被合规拦截，文案含"合规校验服务暂时不可用" | 查 `/user/balance` |
| fail-closed 误认 | 以为代码 bug，实为余额 | `data-compliance.layer === 'fail_closed'` 可机器识别 |
| 裸 `pi` CLI spawn subagent | stalled | 用 pi 的 subagent 工具（项目级覆盖已修） |
| `BASE_URL` 环境变量 | Vite 把它设为 `/`，集成测试探活失败 | 用 `FINBUDDY_BASE_URL` |
| 本机 proxy | `curl localhost` 返回 502 | `--noproxy '*'` |
| AI SDK 版本 | `UnsupportedModelVersionError` | 已升 AI SDK 5（`stopWhen: stepCountIs()`） |
| refId 乱序 | 抽屉引用号随网络抖动 | `lib/refs.ts` `list()` 已按分配序排序 |
| `writer.write` 时机 | 流结束后写入无效 | 契约校验必须在 `consumeStream()` 之后、流关闭前 |

---

## 6. 必读文件（读完即掌握上下文）

1. `.scratch/finbuddy-agent/issues/04-wencai-workbench-ui.md` — **下一步的票**
2. `.scratch/finbuddy-agent/issues/03-agent-analysis-contract.md` — T3 全记录（含 code-review 与真机验证）
3. `GLOSSARY.md` — 领域术语
4. `docs/adr/0001`、`0002` — 硬决策（尤其 ADR-0002 决策 2/4 是 T4 的核心考点）
5. `app/api/chat/route.ts` — 5 个 data part 的实际产出
6. `lib/citations.ts`、`lib/orchestration.ts` — T4 直接复用
7. `tests/fixtures/real-agent-output.md` — **真实模型输出样例**（T4 可用它做前端 mock，不必每次跑真机）

---

## 7. 诚信提醒

本仓库曾有过"提前写好的完成态文档"（AI-USAGE 记录未发生的纠偏、TESTING 标注未执行的 ✅ PASS），
**已全部删除**。新写文档必须如实：只写真实发生的事；未跑就写 ☐，未验证就写"未验证"。
若测试被跳过（如外部服务不可用），必须**显式 skip 并打印原因**，绝不可当作通过。
