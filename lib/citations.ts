/**
 * Seam 4: 引用角标校验（ADR-0002 决策 2）
 *
 * 设计要点：
 * - 角标格式 `[^ref_X]`，X 由网关分配器（lib/refs.ts）单调生成。
 * - 只有本轮工具真正返回过的 refId 才有效；其余一律判定失效。
 * - 校验是纯函数，服务端（写正文后自检）与前端（渲染前强制校验）共用同一实现，
 *   避免两处规则漂移。
 * - 编造的角标不由本模块决定如何展示，只负责"判定"；渲染为灰色"引用失效"
 *   且不响应点击是 T4 前端的职责。
 */

/** 严格匹配 `[^ref_<数字>]`。不匹配 `[^1]`（脚注）、`[^REF_1]`（大小写）等近似写法。 */
const CITATION_RE = /\[\^(ref_\d+)\]/g;

/** 抽取正文中出现的角标 id，去重并保持首次出现顺序。 */
export function extractCitations(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(CITATION_RE)) {
    seen.add(m[1]);
  }
  return Array.from(seen);
}

export interface CitationCheck {
  /** 正文中出现过的全部角标 id（去重，出现顺序）。 */
  cited: string[];
  /** 命中本轮工具实际返回集合的角标（可点击/可滑出存证抽屉）。 */
  valid: string[];
  /** 不在本轮返回集合内的角标（编造或错配）→ 前端渲染为"引用失效"。 */
  invalid: string[];
  /** 正文是否挂了任何角标；为 false 时由契约层判断是否需要提醒模型补挂。 */
  hasAny: boolean;
}

/**
 * 校验正文角标。
 *
 * @param text 模型生成的正文
 * @param allowedRefIds 本轮工具调用实际返回过的 refId 集合（顺序无关）
 */
export function checkCitations(text: string, allowedRefIds: readonly string[]): CitationCheck {
  const allowed = new Set(allowedRefIds);
  const cited = extractCitations(text);
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const id of cited) {
    if (allowed.has(id)) valid.push(id);
    else invalid.push(id);
  }

  return { cited, valid, invalid, hasAny: cited.length > 0 };
}
