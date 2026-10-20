# 调研：这个项目的前人工作与可借鉴对象

**日期**：2026-10-16
**目的**：在重构定位之前，先查清"证据优先的金融 LLM 护栏"这件事有没有人做过、做到什么程度。
**结论摘要**：定位本身不是新的 —— 它已有名字（citation-grounded / attribution verification）和
专门文献。项目里每一个组件都能在别处找到更成熟的对应物。**唯一被研究证据明确支持、且尚未解决的
那一块，是"强制弃答（fail-closed abstention）"。**

> 本文所有链接均为实际访问所得。凡未验证的推断均显式标注"未验证"。
> 部分来源是厂商营销内容（Markdown 标注 `[营销]`），仅用于交叉印证趋势，不作为论据。

---

## 一、定位撞名：这件事已有名字和文献

我的定位原话是"LLM 负责成文，引用有效性由确定性代码裁定"。检索后发现这已经是
**grounded generation / attribution verification** 的既有议题，且已有产品化的描述几乎逐字重合：

> "If the source material does not support a claim, the system either says so or does not answer.
> Citations are not decoration; they are how the system proves it did not invent the answer."
> —— [Edtek: Citation-Grounded LLM](https://edtek.ai/kb/citation-grounded-llm)

> "attribution verification ... checks whether the citations in the generated text are supported by
> the cited passages ... can trigger re-generation, response filtering, or user warnings"
> —— [Attribution and Citation: Sourcing LLM Outputs](https://mbrenndoerfer.com/writing/attribution-and-citation)

**含义**：这不是护城河，这是一个已经有人占据的类别。以"我们要做可追溯引用"作为差异化站不住。

### 更糟的是：领域已经越过了我做的那一层

我的 `lib/citations.ts` 只校验**引用号是否存在**（refId ∈ 本轮工具返回值）。
README 自己也承认："只覆盖角标存在性，不验数值本身是否正确"。

而文献的重心早已移到**引用是否真的支持该论断**（faithfulness / attribution alignment）：

| 工作 | 做什么 | 链接 |
|---|---|---|
| CiteGuard | 引用归属校验，CiteME benchmark 达 65.4%（人类 69.7%） | [arXiv 2510.17853](https://arxiv.org/html/2510.17853v1) |
| RefLens | 端到端证据落地的引用校验，要求**逐字抽出**支撑/反驳片段 | [AAAI 2024](https://ojs.aaai.org/index.php/AAAI/article/view/42361/46322) |
| CiteTracer | 级联多智能体检测，分为 Real / Potential / Hallucinated 三类 | [arXiv 2605.08583](https://arxiv.org/html/2605.08583v1) |
| refchecker | 工程实现：确定性预筛 + LLM 深搜 + 元数据复验 | [GitHub](https://github.com/markrussinovich/refchecker) |

**引用造假的规模**（说明问题真实存在，但也说明很多人已经在解决它）：
GPT-4o 生成的文献综述中 **19.9% 引用完全伪造**，另有 **45.4% 存在著录错误** ——
[EurekAlert 报道的研究](https://www.eurekalert.org/news-releases/1106130)、
[MDPI 论文](https://www.mdpi.com/2306-5729/11/5/122)。

**结论**：在引用校验这一层，我实现的是**已知问题的最弱形态**，且落后两代。不要在这里竞争。

---

## 二、数值护栏：我的"对账器"是标准模式的一个应用

我以为原创的 `lib/reconcile.ts`，其实对应一个成熟的数据工程实践：**在数据进入计算之前做断言校验**
（Great Expectations / dbt tests / Pandera / Soda）。

关键的是，这套实践的存在理由与我的处境**逐字吻合**：

> "Validation before the warehouse ... **This matters most when the upstream source is outside your
> control, which is the usual case for data pulled from third-party APIs** ... where a vendor can
> change a field without telling anyone."
> —— [Great Expectations vs dbt Tests](https://datatrail.ai/blog/great-expectations-vs-dbt-tests)

| 工具 | 做什么 | 链接 |
|---|---|---|
| Great Expectations | 表达"我对数据的期望"并验证，含 ingestion 阶段 | [文档](https://docs.greatexpectations.io/) |
| dbt tests / dbt-expectations | 断言与模型同处，随构建运行 | [dbt-expectations](https://github.com/calogica/dbt-expectations) |
| Pandera | Python 原生 DataFrame 校验 | [Pandera](https://pandera.readthedocs.io/) |

**含义**：模式是标准的；我的**应用**（用结构特征检测金融数据口径错误）可能仍算新，
但我不该把它说成发明。"把 GX 的思路搬到 LLM 证据层"是一个更诚实、也更好讲的描述。

---

## 三、致命一击：TTM 的正确算法是领域标准，我发明了一个错的

这是本次调研最有价值的发现。

财务数据供应商按**年内累计（YTD）**返回是常态，因此 TTM 有一个**领域标准公式**：

```
方法 A（连续四季）：TTM = 最近 4 个单季之和
方法 B（累计口径，业界常用）：
        TTM = 最近完整财年 + 本期 YTD − 上年同期 YTD
```

来源：[Wall Street Prep: TTM](https://www.wallstreetprep.com/knowledge/ttm-trailing-twelve-months)、
[Xero: What Does TTM Mean](https://www.xero.com/us/glossary/ttm)。

而且"把累计当单季相加"被明确列为**常见错误**：

> "the common mistake that people make. **They don't use the year to date** ... That is incorrect.
> That's a common mistake that people make."
> —— [Training NYC: TTM & Seasonality](https://training-nyc.com/learn/financial-modeling/ttm-calculation-video)

**对本项目的直接后果（可执行的修正）**：

我的 `lib/financials.ts#sumTTM` 只实现了方法 A 的"直接相加"，而扶摇返回的是累计值。
正确的修法是：

1. **取够期数**：`limit: 5` → `limit: 6`。要从累计值还原 1 年单季，需要 **6 期累计**
   （N 期累计差分出 N−1 个单季，要 4 个单季就需 5 期差分，跨年边界还要多一期）。
2. **年内差分得单季**：同一财年内，`单季 = 本期累计 − 上期累计`。
3. **跨年取满年值**：上年 Q4 的累计值即该年全年。
4. **再按方法 A 或 B 得 TTM**。

这不是"我发明的对账规则"，是**用行业标准公式替换一个错误实现**。
对账器应保留，但降级为**兜底断言**（万一公式又被改错），而不是主要的正确性来源。

> 教训：我第一反应是"写个检测器抓住这个错误"，而不是"去查这个指标的标准算法"。
> 检测器是需要的，但**先查标准**能省掉整件事 —— 方法 B 的存在本身就说明这个坑是已知的。

---

## 四、唯一真正站得住的一块：强制弃答

这是调研里唯一**支持**（而非否定）项目方向的证据。

**AbstentionBench**（[arXiv 2506.09038](https://arxiv.org/html/2506.09038v1)，
[NeurIPS 2025 poster](https://neurips.cc/virtual/2025/poster/121675)）证明：

- "**abstention is an unsolved problem**, and one where **scaling models is of little use**"
- "**reasoning fine-tuning degrades abstention (by 24% on average)**"
- "while a carefully crafted system prompt can boost abstention in practice,
  **it does not resolve models' fundamental inability to reason about uncertainty**"

**这三条合起来，正好论证了本项目的核心机制为什么必须有：**

> 既然"弃答"无法靠提示词可靠获得、且模型越训练推理能力反而越差，
> 那么**在模型外部、用确定性代码强制它弃答**就不是 hack，而是唯一可行的路径。
> `lib/output-contract.ts` 的"信息真空期硬编码"（ADR-0001 决策 2）因此从
> "一个偷懒的机械判定"变成了**对已记录模型缺陷的正确应对**。

配套证据 —— **fail-closed 是一个被命名的政策选择，且业界默认是 fail-open**：

> "fail-open means: when the system is uncertain, it allows the action.
> Fail-closed means: when uncertain, it blocks."
> "**Every LLM safety system is fail-open**"
> —— [LinkedIn 讨论](https://www.linkedin.com/posts/jonathansilvasantos_every-llm-safety-system-is-fail-open-thats-activity-7432624111459332096-0Lw)
> `[营销/社交内容，仅作趋势印证]`

工程界已经在做这个开关：[LiteLLM issue #19779](https://github.com/BerriAI/litellm/issues/19779)
讨论"generic guardrail 的 fail-open 模式"，回复明确指出
"fail-open vs fail-closed is a fundamental policy decision that **every guardrail system needs to
support explicitly**"。

**含义**：fail-closed 本身不是新概念（我不能声称是发明），
但**在金融证据层强制弃答**这个组合，我没有找到现成实现。这是最窄也最结实的立足点。

---

## 五、生态全景：这个赛道很拥挤

必须诚实说明：GitHub 上相关项目非常多，且不少是零 star 的个人作品。

| 项目 | 是什么 | 链接 |
|---|---|---|
| **chainlens** | 多模型 AI 研究助手，**股票产业链**研究，来源分级、chunk 级证据引用、反向事实核查，TypeScript/Next.js/**DeepSeek** | [GitHub](https://github.com/topics/citation-verification?l=typescript) |
| FinGPT | 开源金融 LLM 框架（数据→训练→应用） | [GitHub](https://github.com/ai4finance-foundation/fingpt) |
| OpenBB | 开源投研数据平台（74k star），含 Copilot | [GitHub](https://github.com/openbq-org/OpenBB) |
| Agentic FinSearch | 实时金融数据检索的参考架构 | [GitHub](https://github.com/YangletLiu/FinGPT-Search-Agent) |
| awesome-auditable-ai | **审计类 AI 的策展清单**（可靠性、监控、失败归因、决策记录、证据溯源） | [GitHub](https://github.com/yzhao062/awesome-auditable-ai) |
| Guardrails AI / NeMo Guardrails | 通用 LLM 输出护栏框架（含 reject 输出的 output rails） | [NeMo](https://github.com/NVIDIA-NeMo/Guardrails) |

**`chainlens` 值得特别注意**：同样是 TypeScript/Next.js + DeepSeek，
同样是"股票研究 + 来源分级 + 证据引用 + 反向核查"。与本项目高度重叠，但 star 数为 1。

**awesome-auditable-ai 说明**："可审计 AI 智能体"已经是一个有成套词汇
（evidence tracing、execution provenance、decision records）的领域。

### 金融数值推理的评测基准（可用来验证，也可用来定位差距）

| 基准 | 规模 | 现状 |
|---|---|---|
| FinQA | 8,281 问答对，S&P 500 财报 | GPT-4 ≈76% execution accuracy；SOTA ≈89%；人类专家 91% |
| TAT-QA | 16,552 问，表+文混合 | TAT-LLM 70B 达 88.4% F1 |
| MultiHiertt | 10,440 问，多层级表格 | 指出单表基准低估难度 |
| ConvFinQA | 多轮对话式 | 最佳模型 68.9% vs 专家 89.4% |

来源：[FinQA 综述](https://beancount.io/bean-labs/research-logs/2026/05/13/finqa-numerical-reasoning-financial-data)、
[TAT-QA](https://beancount.io/bean-labs/research-logs/2026/05/14/tat-qa-hybrid-tabular-textual-financial-question-answering)。
一个关键观察：**约 50% 的错误来自领域知识缺口，而不是检索失败或算术执行错误** ——
"模型找对了数字，但用错了金融逻辑"。这与我踩的 TTM 口径坑是同一类。

---

## 六、对定位的结论

### 站不住的
1. "可追溯引用" —— 类别已被占据，我的实现是最弱形态且落后两代。
2. "确定性算账" —— 正确做法是标准算法（TTM 方法 B）+ 工具调用，我发明了一个错公式。
3. "fail-closed" 作为发明 —— 它是个已被命名的配置项。
4. 作为"金融投研产品"竞争 —— FinGPT / OpenBB（74k star）/ 问财 都在这里。

### 可能站得住的
1. **强制弃答（abstention enforcement）**：研究证明提示词解决不了、scaling 解决不了、
   推理微调反而更糟。确定性外部强制是唯一路径 —— 这一条有论文背书。
2. **金融数据口径的摄入层断言**：模式是标准的（GX/dbt），但**应用到金融口径**我没找到现成实现。
   我自己踩到的 YTD 真实缺陷就是它的价值证明。
3. **把上述两点做成可复用的工具 + 示范**，而不是一个产品。

### 姿态建议
放弃"投研助手"叙事（无法竞争），改为**窄而硬的工具叙事**：
"在金融数据上，让 LLM 说'不知道'的那个闸门"。它小、可验证、有论文依据、没人在做。

---

## 七、未找到 / 待确认

- 未找到**专门做"金融口径自动 sanity check"** 的开源库（GX 是通用框架，非金融专用）。
  这一点若属实，是本项目最实的差异化，但需要更彻底地检索（含中文圈：聚宽/米筐/Tushare 生态）。
- 未验证 ALCE / Attributed QA benchmark 的具体指标定义（检索中仅间接提及）。
- 未验证 LLM Guard 的 `no_refusal` / 毒性与弃答检测在该场景的适用性。
- `chainlens`（star=1）未深入阅读源码，无法判断其证据校验的实际强度。
