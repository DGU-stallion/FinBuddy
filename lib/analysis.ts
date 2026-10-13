/**
 * Seam 3: 命题重构与子问题拆解（ADR-0002 决策 3）
 *
 * 设计要点：
 * - 中性问题（"中际旭创怎么样"）先重构为可证伪命题，三栏才有辩证基准。
 * - 子问题限制在 2~3 个：少于 2 个三栏无素材，多于 3 个超出 5 步工具预算。
 * - 意图标签必须含标的标签，T4 标签微调 / T5 重跑依赖它定位标的。
 * - 模型编造未接入的工具名时不整份拒绝，只把该子问题降级为 unverifiable
 *   —— 该子问题最终会落到【无法验证项】，这正是我们要的诚实行为。
 * - 命题里夹带股价预测/买卖指令时整份拒绝：否则三栏退化成荐股（合规红线）。
 *
 * 本模块只做"校验与规范化"，不调用模型；模型交互在 app/api/chat/route.ts。
 */

import {
  containsTradeAction,
  containsGuarantee,
  containsAmbiguousTradeAction,
  AMBIGUOUS_FINANCE_TERMS,
} from './vocabulary';

/** 已接入的核验方（对应 route.ts 的三个网关工具）。 */
export const VERIFICATORS = ['snapshot', 'financials', 'announcements', 'unverifiable'] as const;

export type Verificator = (typeof VERIFICATORS)[number];

export function isVerificator(v: unknown): v is Verificator {
  return typeof v === 'string' && (VERIFICATORS as readonly string[]).includes(v);
}

export interface SubQuestion {
  question: string;
  verificator: Verificator;
}

export interface AnalysisPlan {
  /** 可证伪的投资命题（中性问题的辩证基准）。 */
  reframedClaim: string;
  /** 意图标签，至少含一个「标的: X」标签。 */
  intentTags: string[];
  /** 2~3 个可核验的微观子问题。 */
  subQuestions: SubQuestion[];
}

export type PlanRejection =
  | 'malformed'
  | 'claim_not_falsifiable'
  | 'missing_ticker_tag'
  | 'too_few_sub_questions'
  | 'too_many_sub_questions';

export type PlanValidation =
  | { ok: true; plan: AnalysisPlan }
  | { ok: false; reason: PlanRejection; message: string };

/**
 * 预测/操作语言黑名单。
 *
 * 与 lib/compliance.ts（输入侧拦截）互补：这里扫描**输出侧**（命题重构产出与正文），
 * 防止模型把股价预测或买卖指令夹带回正文。命中即判命题不可证伪。
 *
 * 注意：不裸拦"涨/跌"，否则会误伤"营收下滑""毛利承压"这类基本面表述。
 */
const PREDICTION_PATTERNS: Array<[RegExp, string]> = [
  [/目标价/, '目标价'],
  [/(会|将|要|即将|马上|一定)涨/, '$1涨'],
  [/(会|将|要|即将|马上|一定)跌/, '$1跌'],
  [/必涨/, '必涨'],
  [/必跌/, '必跌'],
  [/涨停/, '涨停'],
  [/跌停/, '跌停'],
  [/稳赚不赔/, '稳赚不赔'],
  [/保本/, '保本'],
  [/翻倍/, '翻倍'],
  [/建议(买入|卖出)/, '建议买卖'],
  [/建议(加仓|减仓|建仓|清仓)/, '建议调仓'],
  [/立即(买入|卖出|建仓)/, '立即操作'],
];

/** 返回命中的预测/操作语言片段；空数组表示该文本可接受。 */
export function scanPredictionLanguage(text: string): string[] {
  const hits: string[] = [];
  for (const [re, label] of PREDICTION_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  // 共享操作/承诺词表：与输入侧、追问侧保持单一事实来源。
  // 曾漂移出真实漏洞：止损/止盈 输入侧拦、输出侧放。
  if (containsTradeAction(text)) hits.push('操作动词');
  if (containsGuarantee(text)) hits.push('收益承诺');
  // 财务术语歧义词（杠杆/满仓）需语境消歧：
  // T4 真机回归发现 8 次运行 5 次误报，模型写的是「固定成本杠杆」「经营杠杆」，
  // 属于标准财务分析表述，不是买卖结论。
  if (containsAmbiguousTradeAction(text, AMBIGUOUS_FINANCE_TERMS)) hits.push('操作动词');
  return Array.from(new Set(hits));
}

/** 「标的: X」标签识别（冒号半角/全角/空格皆可）。 */
const TICKER_TAG_RE = /^标的\s*[:：]?\s*\S+/;

/**
 * 确定性兜底命题：模型产出的计划不可用时使用。
 *
 * 必须是**假设**而非结论——"待核验"三字不可省，否则会被读成系统判断。
 * 确定性（无随机、无时间依赖），保证同一输入得到同一兜底命题。
 */
export function fallbackReframe(name: string): string {
  return `${name}当前的基本面表现与其近期市场传闻相符，不存在重大经营风险（待核验假设）。`;
}

/**
 * 校验并规范化模型产出的分析计划。
 *
 * 拒绝是安全的（调用方回退到 fallbackReframe），但**降级优于拒绝**：
 * 编造的工具名只降级为 unverifiable，不整份拒绝。
 */
export function validateAnalysisPlan(raw: unknown): PlanValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'malformed', message: '分析计划不是对象' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.reframedClaim !== 'string' || obj.reframedClaim.trim() === '') {
    return { ok: false, reason: 'malformed', message: '命题为空' };
  }
  if (!Array.isArray(obj.intentTags) || obj.intentTags.some((t) => typeof t !== 'string')) {
    return { ok: false, reason: 'malformed', message: '意图标签形状错误' };
  }
  if (!Array.isArray(obj.subQuestions)) {
    return { ok: false, reason: 'malformed', message: '子问题不是数组' };
  }
  for (const sq of obj.subQuestions) {
    if (typeof sq !== 'object' || sq === null) {
      return { ok: false, reason: 'malformed', message: '子问题不是对象' };
    }
    const q = (sq as Record<string, unknown>).question;
    if (typeof q !== 'string' || q.trim() === '') {
      return { ok: false, reason: 'malformed', message: '子问题文本缺失' };
    }
  }

  const reframedClaim = obj.reframedClaim.trim();

  // 命题不得夹带股价预测/买卖指令 —— 否则三栏失去辩证基准，退化为荐股。
  if (scanPredictionLanguage(reframedClaim).length > 0) {
    return {
      ok: false,
      reason: 'claim_not_falsifiable',
      message: '命题中夹带股价预测或买卖指令，不是可证伪的基本面命题',
    };
  }

  const intentTags = (obj.intentTags as string[]).map((t) => t.trim()).filter((t) => t !== '');
  if (!intentTags.some((t) => TICKER_TAG_RE.test(t))) {
    return { ok: false, reason: 'missing_ticker_tag', message: '意图标签缺少「标的: X」' };
  }

  const rawSub = obj.subQuestions as Array<Record<string, unknown>>;
  if (rawSub.length < 2) {
    return { ok: false, reason: 'too_few_sub_questions', message: '子问题少于 2 个，三栏无素材' };
  }
  if (rawSub.length > 3) {
    return { ok: false, reason: 'too_many_sub_questions', message: '子问题多于 3 个，超出工具预算' };
  }

  const subQuestions: SubQuestion[] = rawSub.map((sq) => ({
    question: (sq.question as string).trim(),
    // 模型编造未接入的工具名 → 降级为 unverifiable（该子问题将落入【无法验证项】）
    verificator: isVerificator(sq.verificator) ? sq.verificator : 'unverifiable',
  }));

  return { ok: true, plan: { reframedClaim, intentTags, subQuestions } };
}

// ---------- 模型产出的解析 ----------

/**
 * 容错解析模型输出的 JSON。
 *
 * 模型常见整形：```json 围栏、前后夹解释文字。先剥围栏，再定位第一个
 * 配对完整的顶层 JSON 对象（按花括号计数配对，不用最后一个 } 截断）。
 *
 * 解析失败返回 null 而不抛错 —— 由调用方决定是否回退兜底。
 * 绝不"尽力猜"半成品计划，那会让三栏建立在错误命题上。
 */
export function parsePlanJson(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  // 剥 Markdown 代码围栏
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], extractFirstJsonObject(raw), raw].filter(
    (s): s is string => typeof s === 'string' && s.trim() !== '',
  );

  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c.trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

/** 按花括号配对取出第一个完整的顶层 JSON 对象（跳过字符串内的花括号）。 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ---------- 提示词构造 ----------

/**
 * 构造「分析计划」提示词（命题重构 + 意图标签 + 子问题 + 追问）。
 *
 * 追问在此阶段一并产出：followUps 会经 lib/followups.ts 做确定性核验向
 * 过滤后直接展示（模型生成的更"递进"，确定性过滤保证合规）。
 */
export function buildPlanPrompt(userText: string, priorSummary?: string): string {
  // 多轮（T5）：把上一轮的标的带进提示词，避免指代型追问（"那它的毛利率呢"）
  // 丢标的导致标签漂移。摘要已在 lib/context-summary.ts 里压缩过，不含完整对话。
  const contextSection = priorSummary
    ? `\n【上一轮上下文（仅结构化摘要，仅供消解指代，不得当作本轮证据）】\n${priorSummary}\n`
    : '';

  return `你是投资命题核验助手的前置分析器。把用户的输入转换成一份结构化的核验计划。
${contextSection}
用户输入：${userText}

要求：
1. reframedClaim 必须是一个基本面可证伪命题（如"X 公司当前业绩强劲，无重大经营风险"）。
   绝对禁止出现股价预测（目标价、会涨/会跌、涨停）、买卖指令（建议买入/卖出/加仓）或收益承诺（稳赚不赔/翻倍）。
   如果用户输入是中性问题（如"X 怎么样"），请将其重构为可证伪命题后再组织证据。
2. intentTags 必须包含一个以"标的: "开头的标签（值为标的名或代码），可再补"事件: ""核验维度: "标签。
3. subQuestions 给出 2~3 个可核验的微观子问题，不要多也不要少。每个子问题的 verificator 只能取下列之一：
   - "snapshot"：行情、估值、涨跌幅
   - "financials"：营收、净利率、毛利率等财务参数
   - "announcements"：法定公告、新闻、传闻披露
   - "unverifiable"：无法通过上述接口获取（如客户集中度、未披露合同）
4. followUps 给出 3 个逻辑递进的核验向追问（证伪 / 下钻 / 对比方向），绝对禁止操作向（如"要不要买"）与预测向。

只输出一个 JSON 对象，不要任何解释文字，不要 Markdown 围栏：
{
  "reframedClaim": "...",
  "intentTags": ["标的: ...", "事件: ..."],
  "subQuestions": [{ "question": "...", "verificator": "financials" }],
  "followUps": ["...", "...", "..."]
}`;
}

/**
 * 构造主循环系统提示词。
 *
 * 计划已确认，模型**不再负责拆解**，只负责按子问题调工具并成稿。
 * 追问也不在此处生成（由计划阶段产出并过确定性过滤）。
 */
export function buildSystemPrompt(plan: AnalysisPlan, priorSummary?: string): string {
  const subList = plan.subQuestions
    .map((sq, i) => `${i + 1}. ${sq.question}（核验方：${sq.verificator}）`)
    .join('\n');

  // 多轮（T5）：只注入结构化结论摘要（标的 + 已确认事实），不注入完整对话历史。
  // 明确的措辞约束：摘要是"已确认"的，但新事实仍须重新调工具核验，不得凭记忆陈述。
  const contextSection = priorSummary
    ? `
上一轮的结构化结论摘要（仅供消解指代与避免重复调用；若要引用为新事实，仍须本轮重新调用工具核验）：
${priorSummary}
`
    : '';

  return `你是 FinBuddy，一名中立、严谨的投资命题核验助手。

你的职责边界（不可逾越）：
1. 绝不输出投资建议、买卖指令或收益承诺；绝不预测股价（不写目标价、不说会涨会跌、不提涨停）。
2. 绝不编造数据。所有事实必须来自本轮工具返回，并挂上引用号。
3. 严格区分事实与推断。工具没返回的，不要脑补。
4. 公告检索返回 vacuum=true 时表示处于信息真空期，必须归入【无法验证项】，不得推测。

本轮已确认的分析计划（由前置分析器产出，不得推翻重做）：

命题：${plan.reframedClaim}
意图标签：${plan.intentTags.join(' | ')}
待核验子问题：
${subList}
${contextSection}

输出格式（严格按顺序使用以下 Markdown 分栏，每一栏都不得为空）：

【意图解析】
- 简明列出标的、事件与核验维度标签。

【命题重构】
- 复述上面的命题，说明它为何可被证伪。

【支持证据】
- 来自工具的事实，每条挂角标 [^ref_X]。

【反对证据】
- 与命题相悖的事实，每条挂角标 [^ref_X]。

【无法验证项】
- 工具未覆盖、检索为空（信息真空期）或当前无法实时获取的维度，必须写在这里，不得脑补。

【敏感性测算】
- 说明下方滑块卡片所用的基准营收、净利率与口径。

引用规范：角标格式为 [^ref_X]，X 只能取自本轮工具实际返回过的引用号，不得自行编造。
降级数据必须显式声明「非实时」与抓取日期。
推理与输出一律使用中文。回答简洁、高信息密度。`;
}

/**
 * 构造「本轮末尾生成追问」的提示词（ADR-0002 补充决策 5）。
 *
 * 为什么必须在本轮末尾（T4 Spec 轴评审抓出的缺陷）：
 * 原实现把追问放在**计划阶段**（分析之前）与 reframedClaim 一并产出，
 * 因此追问只依据用户提问、与本轮查到的证据无关 —— 无法像票面例子
 * 「其三季报毛利率能否抵御冲击？」那样针对本轮结果下钻。
 * ADR-0002 补充决策 5 的原文是「由 LLM **在本轮末尾**生成（保证逻辑递进）」。
 *
 * 这里把**本轮正文**（含三栏发现）作为依据交给模型，并要求三个方向：
 * 证伪 / 下钻 / 对比 —— 与票面例子对齐。
 *
 * @param body 本轮已成稿的正文（可截断）；为空时退化为仅依据命题。
 */
export function buildFollowUpPrompt(plan: AnalysisPlan, body: string, count: number): string {
  // 截断：追问只需要"本轮发现了什么"，不需要整篇正文（避免 token 膨胀）。
  const excerpt = (body ?? '').trim().slice(0, 2000);
  const findings = excerpt === '' ? '（本轮未取得可引用的正文）' : excerpt;

  return `你是投资命题核验助手的追问生成器。基于**本轮已核验出的具体事实**，
生成 ${count} 个逻辑递进的后续核验问题。

本轮命题：${plan.reframedClaim}
意图标签：${plan.intentTags.join(' | ')}

本轮已核验到的内容（正文摘录）：
${findings}

要求：
1. 恰好 ${count} 个问题，方向依次为：**证伪**（什么证据会推翻本命题）、
   **下钻**（本轮已查到的某个具体事实再深一层）、**对比**（与同行/竞品/历史比）。
2. 必须针对上面**本轮已查到的具体事实**提问，不得泛泛而谈（禁止"这只股票怎么样"这类空泛问题）。
3. 绝对禁止操作向（买入/卖出/加仓/要不要/该不该）与预测向（目标价、会涨/会跌、涨停）。
4. 每个问题必须是可核验的（能通过公告、财报科目或同行数据回答）。

只输出一个 JSON 数组，不要任何解释文字，不要 Markdown 围栏：
["问题1", "问题2", "问题3"]`;
}
