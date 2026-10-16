# 测试文档

> 本文记录**实际跑过的**验证。未跑的一律标注为未跑，跳过的一律写明原因。
> 本仓库曾出现过"提前写好的完成态文档"，已全部删除；本文遵守同一纪律。

---

## 原题要求的四类场景 → 覆盖在哪

原题「测试说明」要求至少覆盖：**主链路、数据缺失/接口失败、极端或合规边界**。逐项对应：

| 要求的场景 | 覆盖在哪 | 断言什么 |
|---|---|---|
| **主链路** | `tests/page-render.test.tsx`（13）+ `tests/route-offline.test.ts`（25）+ `tests/agent-contract.integration.test.ts`（2 真机） | 5 个 data part 齐全、三栏渲染、角标可溯源、追问 3 条 |
| **数据缺失 / 接口失败** | `tests/fallback-chain.test.ts`（10）+ `tests/vacuum-chain.test.ts`（3）+ `lib/gateway.test.ts`（6）+ `tests/fixtures` 回归 | L1 超时/报错 → L2 预置存证（显式标注）；L2 未收录 → L3 信息真空期；不得用过期数据冒充正常结论 |
| **接口失败（整服务不可用）** | `scripts/compliance-suite.mjs` 的 fail-closed 分支 + `lib/intent.test.ts` | 服务故障时 `layer='fail_closed'`，文案不得冤枉用户违规，且**不算合规通过** |
| **合规边界** | `node scripts/compliance-suite.mjs`（6 例）+ `lib/compliance.test.ts`（19）+ `lib/vocabulary.test.ts`（25）+ `lib/followups.test.ts`（12） | 直接索取买卖 / 满仓搜哈 / 加五倍杠杆 → 柔性拦截；研究性提问不得误拦；追问不得含操作向 |
| **极端值** | `lib/sensitivity.test.ts`（20）+ `components/SensitivityCard.test.tsx`（9） | 滑块 5%~30% 边界、参数缺失返回 `ok:false`（**绝不默认 0**） |
| **静默失效（工具链层）** | `components/tailwind-classes.test.tsx`（4）+ `tests/ime-submit.test.tsx`（8）+ `tests/submit-guard.test.tsx`（7） | 不存在的 Tailwind 透明度档位、中文输入法 Enter 误提交、同 tick 连点重复提交 |

详见下文「测试分层」与「几条关键断言在证明什么」。

## 一键运行

```bash
npm install
npm test              # 全部测试（单测 + 组件 + 离线端到端 + 真机集成）
npm run typecheck     # tsc --noEmit
npm run build         # next build（含内置 lint 与类型检查）
npm run lint          # ESLint（next/core-web-vitals）
npm run test:compliance   # 合规测试集（需要 dev server）
```

---

## 最近一次完整运行（2026-10-13，本机最终实跑）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | **Test Files 46 passed (46)；Tests 558 passed (558)；0 skipped** |
| `npx tsc --noEmit` | 干净（无输出） |
| `npm run build` | ✓ Compiled successfully |
| `npm run lint` | ✓ No ESLint warnings or errors |
| `node scripts/compliance-suite.mjs` | **6/6 通过，exit 0**（dev server 在跑，余额充足） |
| `npx tsx scripts/t5-verify.mts` | 两个预置案例均 `contract.ok=true`、三栏齐全、参数注入成功 |

### 关于真机测试：本次 0 skipped，但跳过机制仍然存在且必须保留

`tests/agent-contract.integration.test.ts`（2 项）与 `tests/gateway.integration.test.ts`（2 项）
是**真机**测试，需同时满足：

1. `.env` 里有 `DEEPSEEK_API_KEY` / `FUYAO_API_KEY`
2. dev server 在 `FINBUDDY_BASE_URL`（默认 `http://127.0.0.1:3000`）运行
3. 模型服务可用（余额充足）

**本次三项均满足，所以 2/2 通过、0 skipped。** 但本项目**保留**了前置条件不满足时的
显式跳过逻辑，因为此前确实发生过全量运行时 DeepSeek 账户余额耗尽（`is_available: false`）
的情况：那时这两项**显式跳过并打印原因**，

这不是通过。这是刻意的设计：

```
⚠️  T3 真机集成测试已跳过 —— 本次未验证契约在真实模型下的行为。
    原因：模型服务不可用（实测常见原因：DeepSeek 余额耗尽）
    这不是通过，只是前置条件不满足。
```

测试用 `ctx.skip()` 而非静默 `return`，所以 vitest 会正确标记为 skipped。
**任何把"没跑"报告成"通过"的行为都是本项目的红线。**

余额充足后这两项测试**已实际通过**（2026-10-13 最终复跑），
证据是当时写入 `.scratch/finbuddy-agent/issues/03-agent-contract.md`
的真机验证记录（含实际命题文本与追问文本）。

---

## 测试分层：每层在证明什么

分层的核心区别是"证明力度"。低层快且确定，但证明不了真实行为；
高层真实但慢且受外部服务影响。**不能只靠任一层。**

| 层 | 位置 | 数量 | 证明什么 | 不能证明什么 |
|---|---|---|---|---|
| 纯逻辑单测 | `lib/*.test.ts` | 25 个文件 / 383 项 | 校验器/公式**本身**正确（真空期判定、公式精度、词表消歧） | 模型是否照做；UI 是否渲染对 |
| 组件测试 (jsdom) | `components/*.test.tsx` | 9 个文件 / 74 项 | 渲染与**交互**（编造角标不可点击、拖滑块零 fetch） | 真实浏览器布局/样式 |
| 整页渲染 | `tests/page-render.test.tsx` | 13 项 | **页面装配**（data part 接对组件、抽屉联动、合规分流） | 真实流式时序、CSS |
| 离线端到端 | `tests/route-offline.test.ts` | 25 项 | **路由编排**（mock 模型，零余额依赖） | 模型真实输出质量 |
| 真机端到端 | `tests/agent-contract.integration.test.ts`、`tests/gateway.integration.test.ts` | 4 项 | 契约在**真实模型 + 真实数据源**下是否成立 | 可复现性（受余额/网络影响） |
| 真实输出回归 | `tests/fixtures/*` + `tests/real-*.test.ts`、`tests/fallback-chain.test.ts`、`tests/vacuum-chain.test.ts` | 30 项 | 冻结真实输出，**防止解析逻辑退化** | 新场景（fixture 是历史快照） |
| 交付守卫 | `tests/deliverable-docs.test.ts`、`tests/demo-script-check.test.tsx` | 13 项 | 文档声称的东西真的存在（脚本可跑、未部署就不预填已完成） | 文档措辞是否夸大（人判断） |

总计：**46 个文件 / 558 项**。

### 测试文件清单（实际用例数，取自 2026-10-13 最终一次 `vitest run`）

```
lib/  (25 文件 / 383 项)
  evidence 29   analysis-prompt 27   vocabulary 25   session-store 24
  message-view 23   context-summary 21   sensitivity 20   compliance 19
  orchestration 19   output-contract 18   markdown 16   payload-fields 16
  analysis 15   financials 13   followups 12   intent 11   session-switch 11
  format 10   ticker 10   citations 9   preset-cases 9   refs 8   rerun 8
  gateway 6   fallback 4

components/  (9 文件 / 74 项)
  EvidenceDrawer 11   IntentTags 11   SessionSidebar 11   SensitivityCard 9
  CitationText 8   ComplianceNotice 7   EvidenceColumns 7   ThinkingTimeline 6
  tailwind-classes 4

tests/  (12 文件 / 100 项)
  route-offline 25 (离线端到端)   page-render 13   real-t4-regression 13
  fallback-chain 10   deliverable-docs 9   ime-submit 8   submit-guard 7
  demo-script-check 4   real-output-regression 4   vacuum-chain 3
  agent-contract.integration 2 (真机)   gateway.integration 2 (真机)
```

---

## 几条关键断言在证明什么

### 1. 编造角标"不可点击"（ADR-0002 决策 2 的核心考点）

服务端**先** merge 正文、**后**跑契约校验，所以编造角标**一定会到达前端**。
因此强制校验的落点在前端。`components/CitationText.test.tsx` 的断言不是"样式变灰"，
而是**从可交互性层面**杜绝：

```ts
it('编造的角标渲染为"引用失效"且不是按钮（不可点击）', () => {
  render(<CitationText text="官方已澄清[^ref_7]" allowedRefIds={['ref_1']} onOpenRef={() => {}} />);
  expect(screen.queryAllByRole('button')).toHaveLength(0);   // 整段里没有任何按钮
  expect(screen.getByLabelText(/引用失效 ref_7/)).toBeDefined();
});

it('点击失效角标不会触发存证抽屉', () => {
  fireEvent.click(screen.getByLabelText(/引用失效 ref_7/));
  expect(onOpen).not.toHaveBeenCalled();
});
```

失效角标渲染为 `<span>` 而非 `<button>` —— 不只是"置灰但还能点"。

### 2. 滑块拖动"零 LLM 请求"

票面要求"Network 面板不产生 LLM 请求"。断言方式是**桩掉 `fetch` 后连拖 5 帧**：

```ts
for (const v of [5, 10, 20, 25, 30]) fireEvent.change(slider, { target: { value: String(v) } });
expect(after).not.toBe(before);      // 确实每帧重算
expect(fetchSpy).not.toHaveBeenCalled();   // 而且一个请求都没发
```

不是靠"代码里没写 fetch"这种自述。

### 3. 公式精度"误差 = 0"

`lib/sensitivity.test.ts` 同时断言三件事，防止"实现与测试共用同一错误公式"：

```ts
const expected = 163e8 * 0.2 * 0.2236 * 0.85;
expect(r.impact).toBe(expected);      // 同一浮点序列，误差为 0
expect(r.expected).toBe(expected);
expect(r.impact).toBe(619595600);     // 硬编码字面值（独立锚点）
```

第三行是关键：前两行是"自证"，第三行由独立计算给出，能真正抓住公式改动。

### 4. 多轮"不带完整对话历史"

spec 交互决策要求只带结构化结论摘要。`tests/route-offline.test.ts` 直接检查
发给模型的请求体：

```ts
expect(flat).toContain('上一轮已确认的结构化结论');   // 摘要在场
expect(flat).not.toContain('【支持证据】营收与净利率保持稳定。');  // 完整正文不在
```

**这条断言抓出了真实缺陷**：修复前的实现把整段历史经
`convertToModelMessages(messages)` 送进模型，违反 spec，且会让模型绕过摘要复述旧正文。
修复后只送当前轮（`selectCurrentTurn`），历史一律压缩进 system。

### 5. 真实输出回归（fixture 是真实的，不可改）

`tests/fixtures/real-agent-output.md` 与 `tests/fixtures/real-t4-run.json`
是**真机抓取**的模型原始输出。铁律写在测试文件头：

> fixture 是真实输出，**不得为了让测试通过而修改它**。
> 若测试失败，先怀疑解析逻辑或词表，而不是改 fixture。

这条纪律在 T4 期间直接生效：真机回归发现 `杠杆` 被误判为买卖结论
（8 次运行误报 5 次以上），**改的是词表，不是 fixture**。

---

## 离线端到端：为什么需要 mock 模型

`tests/support/mock-model.ts` 是一个可编程的 OpenAI 兼容 mock 服务。存在的理由：

1. **余额耗尽时覆盖不为零**。真机测试只能诚实跳过，但路由层编排
   （多轮摘要注入、data part 顺序、三条合规分支）此前覆盖为**零**。
2. **评委可零成本复现**。端到端断言不应以"账户里有钱"为前提。
3. **可做对抗性测试**。例如让 mock 故意返回带编造角标的正文，
   验证契约真能判出 `fabricated_citation`。

它只实现本项目用到的协议子集，**不做兼容性兜底** —— 那会掩盖真实不匹配。

---

## 真机验证脚本

```bash
npx next dev                                  # 终端 A
node scripts/compliance-suite.mjs             # 终端 B：合规测试集，期望 6/6
node scripts/single-render-check.mjs          # 真实浏览器：一次提问必须只渲染一轮
node scripts/ime-submit-check.mjs             # 真实浏览器：输入法选词的 Enter 不得触发提交
node scripts/t4-e2e.mjs --live                # 真机 SSE → 前端视图模型
node scripts/t4-e2e.mjs /tmp/real.sse         # 或喂一份已落盘的 SSE
npx tsx scripts/t5-verify.mts                 # 两个预置案例的测算参数注入
```

**两个浏览器验证脚本的存在理由**（都是"单测看不见"的缺陷，且均已做变异测试）：

- `single-render-check.mjs` —— 用户三次报告"对话还是出现两次"。真因是路由把
  `data-*` 写在 `start` **之前**，导致 AI SDK 开出**两条** assistant 消息。
  协议层由 `tests/route-offline.test.ts` 锁定；但"渲染成两轮"是它的后果，
  必须在真实浏览器里**数轮次**才算验证到用户看到的东西。
  注意：回放流的 `start` **必须带 `messageId`**，否则脚本会失去牙齿（实测）。
- `ime-submit-check.mjs` —— 输入法打字时按 Enter 选词被当成提交，
  把未打完的拼音发出去。Playwright 的 `fill()` 绕过输入法，测不出这条；
  必须用 CDP 的 `Input.imeSetComposition` 模拟真实组词。

真机确认过的行为（2026-10-13）：

- 中际旭创一轮：**4 条存证**（snapshot/announcements/financials）、契约 `ok`、
  **21 个角标全部可溯源**；把其中一个篡改为 `ref_99` 后**立即被判失效**。
- 测算参数注入：`baseRevenue = 1245.19 亿（TTM）`、`netMargin = 35.27%`、
  `taxRate = 14.68%`（**由 Σ所得税费用 ÷ Σ税前利润推导**，非硬编码 15%）。
  ⚠️ 本行此前写的是 `taxRate = 15%`，是**修复前**的错算法残留，已更正
  （那时硬编码 15%，与实际推导值不符；见缺陷表 #11）。
- 时间轴 7 步；追问 3 条且真"递进"（行业需求 → 光芯片成本 → 同行对比，非模板）。
- 宁德时代一轮命中**真实信息真空期**：模型在【无法验证项】写出
  「**不得推测** —— 无法据此判定传闻为真，也无法据此判定传闻为假」。

---

## 未验证 / 已知边界

诚实列出，避免读者高估覆盖：

- [x] ~~**真机集成测试最近一次为 skipped**（DeepSeek 余额耗尽）~~ → **已重跑并通过**
      （2026-10-13）：`npx vitest run` → **46 files / 558 passed / 0 skipped**；
      `node scripts/compliance-suite.mjs` → **6/6, exit 0**。
- [ ] **响应式布局仅验证 1280px+ 桌面端**（移动端为 spec 明确的 Out of Scope）。
- [ ] **浏览器真实渲染未做视觉回归测试**（无 Playwright/截图对比）。
      组件测试覆盖的是行为与可交互性，不是像素。
- [ ] **提示词注入攻击未做专项测试**（例如用户输入"忽略以上指令"）。
      系统提示词有约束，但未做对抗性验证。
- [ ] **词表消歧的假阴性边界**：`杠杆` 等歧义词采用"无操作标记即视为术语"的取向，
      模型若用未预料到的说法表达操作意图会漏报。该风险在
      `lib/vocabulary.test.ts` 中被**显式断言为已知边界**，不假装为零。
- [x] ~~`npm run lint` 未配置~~ → **已修复**（2026-10-13）：补充 `.eslintrc.json`
      （extends `next/core-web-vitals`）。现 `npm run lint` 通过：**No ESLint warnings or errors**。

---

## 变异测试：验证"测试本身有没有漏洞"

测试全绿不代表测试有效 —— 断言写松了，代码坏掉它也不会响。因此对关键断言
做过**变异测试**（故意改坏实现，确认测试会失败）：

### 案例：测算卡片的装配断言

`tests/page-render.test.tsx` 断言"有财务存证时必须渲染测算卡片"。
初版只断言标题 `营收冲击推演` 出现。变异实验：把 `SensitivityCard` 改成
**恒走"参数缺失"分支**（模拟参数注入断裂）——

**初版断言仍然通过**。原因：参数缺失分支也渲染同一个标题，但它渲染的是
"本轮未取得可测算的财务参数"，而不是滑块。也就是说，初版断言**抓不到
"参数注入断裂"这个最可能的故障**。

已加强为断言只在参数就位时出现的内容：

```ts
expect(t).toContain('营收冲击推演');
expect(t).toContain('营收整体下滑幅度');       // 滑块标签：仅参数就位时渲染
expect(t).toContain('参数溯源');               // 口径与 refId 标注
expect(t).not.toContain('本轮未取得可测算的财务参数');
```

加强后重做变异：测试**正确失败**，并在输出里打出"本轮未取得可测算的财务参数"
（正是被注入的坏状态）。

**这条记录的意义**：说明本项目的测试数字不是靠松断言堆出来的。
若没有做这次变异，`384 passed` 里会包含一条**实际无效**的断言。
