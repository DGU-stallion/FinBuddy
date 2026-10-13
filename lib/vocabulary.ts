/**
 * Seam 14: 跨 seam 共享的合规词表（单一事实来源）
 *
 * 背景（T3 code-review Standards 轴发现）：操作动词词表曾在 3 处各自维护
 * （lib/compliance.ts 输入侧、lib/analysis.ts 输出侧、lib/followups.ts 追问侧），
 * 并且**已经漂移出真实漏洞**：`止损`/`止盈` 在输入侧被拦，输出侧却不扫描 ——
 * 模型在正文写「建议止损」能通过输出契约校验，直达用户。
 * 补齐后又发现第二处漂移：`清仓` 从未被输入侧拦截。
 *
 * 关键区分（来自 ADR-0002 修正 7：裸买卖词在财务语境中多为术语名词）：
 * - **无歧义操作动词**：任何语境都是操作指令（清仓、止损、梭哈…）
 *   → 输入侧无条件拦截；输出侧无条件扫描。
 * - **研究敏感词**：在资金流/评级语境中是名词（"北向资金在买入吗"、"机构评级是买入"）
 *   → 输入侧需研究性语境过滤（由 lib/compliance.ts 负责）；
 *     输出侧仍需无条件扫描，因为正文不该出现操作导向表述。
 * - **财务术语歧义词**（`杠杆`、`满仓`）：既是操作指令，也是标准财务术语
 *   （"经营杠杆""固定成本杠杆""杠杆水平上行"）。
 *   → 单独归入 AMBIGUOUS_FINANCE_TERMS，两侧都需语境消歧（见该常量注释）。
 *
 * 共享的是**词**，不是**规则**：各 seam 的句式差异留在各自模块。
 */

/** 无歧义操作动词：任何语境都是操作指令。 */
export const TRADE_ACTION_TERMS = [
  '加仓',
  '减仓',
  '建仓',
  '清仓',
  '抄底',
  '割肉',
  '梭哈',
  '止损',
  '止盈',
] as const;

/**
 * 财务术语歧义词：既是操作指令，也是标准财务术语。
 *
 * 背景（T4 真机回归发现）：`杠杆` 曾被归入 TRADE_ACTION_TERMS 并无条件扫描，
 * 结果 **8 次真机运行中 5 次误报** —— 模型写的是「固定成本杠杆」「经营杠杆」
 * 「杠杆水平上行」这类标准财务分析表述，却被判为"买卖结论"。
 * 误报代价不只是噪音：前端会因此对**正确输出**弹出契约违规告警，
 * 削弱用户对整套校验的信任（狼来了效应）。
 *
 * 因此这两个词需要语境消歧，不能一刀切：
 *  - `杠杆`：后面跟「水平/率/抬升/上行/下行/经营/财务/固定成本」等词时是术语。
 *  - `满仓`："仓位/库存满仓"是状态描述；"满仓干"才是操作指令。
 * 消歧规则由使用方实现（输入侧 lib/compliance.ts / 输出侧 lib/analysis.ts），
 * 本模块只声明"这些词需要消歧"这一事实，避免规则散落时无人知道要消歧。
 */
export const AMBIGUOUS_FINANCE_TERMS = ['杠杆', '满仓'] as const;

/**
 * 研究敏感词：可能是操作指令，也可能是财务语境中的术语名词。
 * 输入侧交由 lib/compliance.ts 的语境过滤判定；输出侧一律扫描。
 */
export const RESEARCH_SENSITIVE_TERMS = ['买入', '卖出', '上车', '下车'] as const;

/** 收益承诺：无论何种语境都不得出现。 */
export const GUARANTEE_TERMS = ['稳赚不赔', '保本', '翻倍', '必涨', '必跌'] as const;

export function containsTradeAction(text: string): boolean {
  return (
    TRADE_ACTION_TERMS.some((t) => text.includes(t)) ||
    RESEARCH_SENSITIVE_TERMS.some((t) => text.includes(t))
  );
}

/**
 * 判定歧义词是否以**操作指令**含义出现。
 *
 * 设计取向（T4 真机回归后重新定调）：**显式操作标记才是命中依据，默认视为术语。**
 * 依据是两类错误代价不对称：
 *
 * - 假阳性（把「经营杠杆」「双重杠杆效应」判成买卖结论）：真机回归时 8 次运行
 *   误报 5 次以上，前端会对**正确输出**弹出契约违规告警。这类告警频繁出现后
 *   用户会学会忽略它，整套证据完整性机制就名存实亡（狼来了效应）。
 * - 假阴性（模型真写「加杠杆买入」却漏报）：仍有其它层兜底 ——
 *   `建议(买入|卖出|加仓…)`、`目标价`、`涨停`、承诺词等模式依然生效，
 *   且系统提示词已明令禁止给出操作建议。
 *
 * 所以：命中操作前缀/操作句式 → 命中；否则视为术语。
 * 残留风险（模型用未预料到的说法表达操作意图）已在测试中显式声明，
 * 不假装为零。
 */
export function containsAmbiguousTradeAction(text: string, terms: readonly string[]): boolean {
  for (const term of terms) {
    if (!text.includes(term)) continue;

    // 逐个出现地判定：只要有一次是"操作"含义即命中
    // （不能因远处另一处是术语就整体放行：「经营杠杆高，但建议加杠杆」必须拦）。
    let idx = text.indexOf(term);
    while (idx !== -1) {
      if (isOperationUsage(text, idx, term)) return true;
      idx = text.indexOf(term, idx + term.length);
    }
  }
  return false;
}

/**
 * 判定 term 在 text[idx] 处是否为**操作**用法。
 *
 * 操作词总是紧贴在歧义词前面（加杠杆/上杠杆/用杠杆/配杠杆/撬杠杆），
 * 或紧跟在建议句式后，或右侧紧接操作动词（杠杆买入/满仓干）。
 */
function isOperationUsage(text: string, idx: number, term: string): boolean {
  const left = text.slice(Math.max(0, idx - 8), idx).replace(/[\s"'（）()]/g, '');
  const right = text.slice(idx + term.length, idx + term.length + 8).replace(/[\s"'（）()]/g, '');

  // 0) 意图动词出现在左侧窗口（我要加杠杆 / 我打算加杠杆 / N倍杠杆干）：
  //    「加/上/配」等前缀可能被量词与其它字隔开，先看有没有明确意图动词。
  if (/我要|我想|打算|准备|准备用|想要|应该|可以|建议|推荐/.test(left)) {
    // 仅当左侧窗口内确有操作前缀字时才计（避免「我想要了解经营杠杆」误报）
    if (/[加上配撬放]/.test(left) || /倍数|成仓/.test(left)) return true;
  }

  // 1) 操作前缀：必须是**紧邻**歧义词的动词，且中间只许夹量词。
  //
  //    踩过两次坑，记录以免再犯：
  //    a) 用 endsWith 判前缀 → 漏掉「加**五倍**杠杆」（中间夹量词）。
  //    b) 改成"窗口内 includes 前缀字" → `用`/`带` 这类**一字前缀**过宽，
  //       把标准财务术语误判为操作：`利用杠杆效应`、`费用杠杆`、`信用杠杆`、
  //       `使用杠杆比率`、`带杠杆的ETF` 全部误报（Standard 轴评审实证）。
  //       与原始 `杠杆` 误报同类 —— 会造成对**正确输出**的违规告警。
  //
  //    现在的规则：前缀字之后到歧义词之间**只允许量词**，且前缀字前一位
  //    不能是构词字（如「利/费/信/使」）—— 后者会把复合法转成操作指令。
  const ONE_CHAR_PREFIXES = ['加', '上', '配', '撬', '放'];
  // `用`/`带` 单独作前缀时歧义太大（利用/费用/信用/使用/带杠杆的ETF），
  // 仅在紧随明确操作动词时才计（见下方右侧动词规则），故不列入一字前缀。
  const QUANTIFIER_GAP = /^[\d一二三四五六七八九十百千万零两倍成仓位%%.、]*$/;
  // 构词字：出现在一字前缀之前时，说明是复合法而非操作指令
  const COMPOUND_CHARS = ['利', '费', '信', '使', '税', '要', '因'];
  for (const p of ONE_CHAR_PREFIXES) {
    const at = left.lastIndexOf(p);
    if (at === -1) continue;
    if (!QUANTIFIER_GAP.test(left.slice(at + 1))) continue;
    const before = at > 0 ? left[at - 1] : '';
    if (COMPOUND_CHARS.includes(before)) continue;
    return true;
  }

  // 2) 建议/索取句式：「建议用杠杆」「推荐加杠杆」「能加杠杆吗」
  if (/建议|推荐|应该|不妨|可以|要不要|该不该|能不能/.test(left)) return true;

  // 3) 右侧操作动词需紧邻（不隔字）：「杠杆买入」「满仓干」「带杠杆冲进去」
  const OPERATION_RIGHT = ['买入', '卖出', '干', '冲', '搞', '梭哈', '进场', '抄底'];
  if (OPERATION_RIGHT.some((t) => right.startsWith(t))) return true;

  // 4) 左为「用/使用/利用」且右侧是操作结果词 → 是操作指令
  //    （「用杠杆放大收益」vs「利用杠杆效应扩大生产」：后者是"效应/作用"这类术语名词）
  const USAGE_PREFIX = /(用|使用|利用)$/.test(left);
  if (USAGE_PREFIX && /^(放大|获利|套利|博取|赚|翻|加码|做多)/.test(right)) return true;

  return false;
}

export function containsGuarantee(text: string): boolean {
  return GUARANTEE_TERMS.some((t) => text.includes(t));
}
