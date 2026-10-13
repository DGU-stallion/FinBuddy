# 05: 营收冲击推演引擎 + 预置案例 + 多轮上下文

**What to build:** 确定性敏感性测算闭环与产品化收尾。Agent 从财报工具提取的真实参数注入客户端公式引擎，用户拖动"营收整体下滑幅度"滑块时每帧重算净利润冲击；中际旭创预置案例一键出完整链路；多轮追问携带结构化结论摘要（见 ADR-0001 决策 1、4 与 spec 交互决策）。

**Blocked by:** 04

**Status:** done

- [x] 客户端公式引擎：`ΔNetProfit = BaseRevenue × ΔRevenueDeclinePct × NetMargin × (1 - TaxRate)`，纯前端 React State 计算，零 LLM 参与
- [x] 参数注入：Agent 从网关 `lookupFinancialReport` 取得的 `BaseRevenue`(TTM)、`NetMargin`、`TaxRate` 注入公式引擎，并在 UI 标注口径与时点
- [x] 滑块交互：拖动 `ΔRevenueDeclinePct`（5%~30%）时每帧重算，Network 面板不产生 LLM 请求；阈值区间随数值联动变色
- [x] 模型简化声明：测算卡片显式展示"线性一阶近似"局限（无固定成本摊薄、无产能再分配），并声明不构成精确盈利预测
- [x] 中际旭创预置案例：一键触发完整链路（三栏证据 + 存证抽屉 + 测算卡片），数据经真机验证
- [x] 备选预置案例 1 个（数据同样需真机验证可用）
- [x] 多轮上下文：追问时网关维护"本轮标的 + 已确认事实"的结构化结论摘要传给下一轮，不传完整对话历史
- [x] 计算确定性测试：固定参数下断言公式结果与标准数学计算误差 = 0（如 BaseRevenue=163e8, decline=20%, NetMargin=22.36%, TaxRate=15% 时结果精确）

**验收方式（自动化 + 手工）:** 单测断言公式精度；手工拖动滑块观察实时联动且无后端请求。

---

## 完成记录（2026-10-13）

**验证**：`npx vitest run` → 312 passed | 2 skipped；`npx tsc --noEmit` 干净；
`npm run build` → Compiled successfully。

### 逐项对照

| 票面要求 | 实现 | 证据 |
|---|---|---|
| 客户端公式引擎（纯前端，零 LLM） | `lib/sensitivity.ts` `computeSensitivity` | 组件测试断言拖动全程 **零 fetch** |
| 参数注入 + 标注口径时点 | `extractSensitivityParams` + `describeBasis` | 真机：baseRevenue=1245.19亿 TTM / 35.27% / 15% |
| 滑块 5%~30% 每帧重算、联动变色 | `components/SensitivityCard.tsx` | 连拖 5 帧结果变化且无网络请求；`severityTone` 四档 |
| 模型简化声明 | 卡片内显式"线性一阶近似"+ "不构成精确盈利预测" | 组件测试断言文案在场 |
| 中际旭创预置案例全链路 | `lib/preset-cases.ts`（从兜底存证派生） | `npx tsx scripts/t5-verify.mts`：4 存证/三栏齐/测算注入 |
| 备选预置案例 1 个 | 宁德时代，同上 | 5 存证/三栏齐/测算注入 |
| 多轮结构化摘要，不传完整对话 | `lib/context-summary.ts` + `selectCurrentTurn` | `tests/route-offline.test.ts` 直接检查请求体 |
| 计算确定性误差=0 | 同一浮点序列 + 字面值 `619595600` | `lib/sensitivity.test.ts` |

### 本轮抓出的真实缺陷

**1. 多轮把完整对话历史送进模型**（违反 spec 交互决策）

原实现 `convertToModelMessages(messages)` 把整段历史原文送进模型。spec 明确要求
"只带结构化结论摘要，不带完整对话"。影响：爆 token；且模型拿到完整旧对话后会
**绕过摘要直接复述旧正文**，摘要机制白做。

发现的路径是**先写测试**：断言"摘要应在场"**同时断言**"完整正文不应在"。
只写正向断言不会暴露这个缺陷。

修法：新增 `selectCurrentTurn()` 只送当前轮；历史一律经 `buildContextSummary`
压缩后注入 system。

**2. 预置案例硬编码标的名**（与兜底存证存在漂移风险）

`app/page.tsx` 里手写了两个案例的名字与提问，而 L2 兜底存证（`lib/fallback.ts`）
只覆盖预置案例。两者若漂移，**断网演示时用户点进案例反而没有兜底数据** ——
而那正是最需要它的时刻。

修法：`lib/preset-cases.ts` 从 `listFallbackCases()` 派生，并加守卫测试
（案例标的集合必须与兜底存证一致）。

### 新增基础设施：离线端到端

`tests/support/mock-model.ts`（可编程 OpenAI 兼容 mock）+ `tests/route-offline.test.ts`（12 项）。

动机：DeepSeek 余额耗尽时真机集成测试只能诚实跳过，但路由编排（多轮摘要注入、
data part 顺序、三条合规分支、编造角标判定）的覆盖不能因此为**零**。
有了它，评委可零成本复现端到端断言。

### 未验证

- 真机集成测试最近一次为 skipped（DeepSeek 余额耗尽，`is_available: false`）。
- 移动端适配（spec 明确 Out of Scope）。
- 提示词注入的对抗性测试（未做）。
