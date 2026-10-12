/**
 * Seam 8: 跨 seam 共享的合规词表（单一事实来源）
 *
 * 背景（T3 code-review Standards 轴发现）：操作动词词表曾在 3 处各自维护
 * （lib/compliance.ts 输入侧、lib/analysis.ts 输出侧、lib/followups.ts 追问侧），
 * 并且**已经漂移出真实漏洞**：`止损`/`止盈` 在输入侧被拦，输出侧却不扫描 ——
 * 模型在正文写「建议止损」能通过输出契约校验，直达用户。
 * 补齐后又发现第二处漂移：`清仓` 从未被输入侧拦截。
 *
 * 关键区分（来自 ADR-0002 修正 7：裸买卖词在财务语境中多为术语名词）：
 * - **无歧义操作动词**：任何语境都是操作指令（清仓、止损、杠杆…）
 *   → 输入侧无条件拦截；输出侧无条件扫描。
 * - **研究敏感词**：在资金流/评级语境中是名词（"北向资金在买入吗"、"机构评级是买入"）
 *   → 输入侧需研究性语境过滤（由 lib/compliance.ts 负责）；
 *     输出侧仍需无条件扫描，因为正文不该出现操作导向表述。
 *
 * 共享的是**词**，不是**规则**：各 seam 的句式差异留在各自模块。
 */

/** 无歧义操作动词：任何语境都是操作指令。 */
export const TRADE_ACTION_TERMS = [
  '加仓',
  '减仓',
  '建仓',
  '清仓',
  '满仓',
  '杠杆',
  '抄底',
  '割肉',
  '梭哈',
  '止损',
  '止盈',
] as const;

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

export function containsGuarantee(text: string): boolean {
  return GUARANTEE_TERMS.some((t) => text.includes(t));
}
