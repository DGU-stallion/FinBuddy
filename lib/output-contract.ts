/**
 * Seam 5: 输出契约校验（T3「强制三栏输出」「无买卖结论」「降级与真空期声明」）
 *
 * 设计要点：
 * - 契约校验是模型成稿之后的**最后一道确定性防线**。它不做语义判断，
 *   只做可机械判定的结构检查，违规时上层追加确定性修复块。
 * - 三栏必须存在且内容非空（占位符"无/暂无/待补充"视为空 —— 三栏不得糊弄）。
 * - 输出侧买卖语言扫描复用 lib/analysis.ts（与输入侧 lib/compliance.ts 互补）。
 * - 角标校验复用 lib/citations.ts（与 T4 前端同一实现，避免规则漂移）。
 * - L2 降级必须显式声明"非实时"+ 抓取日期；L3 真空期子问题必须在
 *   【无法验证项】里被点名（ADR-0001 决策 2：不得脑补）。
 */

import { checkCitations } from './citations';
import { scanPredictionLanguage } from './analysis';

/** 契约要求存在的分栏（顺序无关，仅校验存在性）。 */
export const REQUIRED_SECTIONS = ['命题重构', '支持证据', '反对证据', '无法验证项'] as const;

/** 视为"空栏"的占位符（模型偷懒时的常见写法）。 */
const PLACEHOLDER_RE = /^(无|暂无|没有|待补充|待核验|n\/?a|none|-+|—+|。|\.)$/i;

export interface FallbackRef {
  refId: string;
  asOf: number;
  note?: string;
}

export interface VacuumSubQuestion {
  question: string;
  /** 网关实际用过的检索关键词；无则为 undefined，退化为按子问题文本匹配。 */
  keyword?: string;
}

export interface OutputContext {
  /** 本轮工具实际分配过的 refId 集合。 */
  refIds: string[];
  /** 本轮触发 L2 降级的数据项（需声明非实时 + 抓取日期）。 */
  fallbackRefs: FallbackRef[];
  /** 本轮落入信息真空期的子问题（需在【无法验证项】中被点名）。 */
  vacuumSubQuestions: VacuumSubQuestion[];
}

export type ViolationCode =
  | 'missing_section'
  | 'shallow_placeholder'
  | 'trade_conclusion'
  | 'fabricated_citation'
  | 'missing_fallback_disclosure'
  | 'missing_vacuum_disclosure';

export interface Violation {
  code: ViolationCode;
  detail: string;
}

export interface OutputValidation {
  ok: boolean;
  violations: Violation[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 抽出某个分栏的正文。
 *
 * @returns 分栏不存在返回 null；分栏存在但无内容返回空串（两者语义不同）。
 */
export function extractSection(text: string, name: string): string | null {
  const re = new RegExp(`【${escapeRe(name)}】([\\s\\S]*?)(?=【|$)`);
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/** 分栏内容是否"实质为空"（空串或占位符）。 */
function isShallow(content: string): boolean {
  if (content === '') return true;
  return PLACEHOLDER_RE.test(content);
}

/** 以 UTC 格式化日期，保证校验与测试不受本地时区影响。 */
function utcDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 校验模型成稿是否满足分析契约。
 *
 * 返回的 violations 为空即 `ok: true`。校验器只报告、不修改文本：
 * 如何修复由调用方决定（当前策略：追加确定性修复块，不二次调模型）。
 */
export function validateAnalysisOutput(text: string, ctx: OutputContext): OutputValidation {
  const violations: Violation[] = [];

  // 1. 三栏（+命题重构）必须存在且内容非空
  for (const name of REQUIRED_SECTIONS) {
    const content = extractSection(text, name);
    if (content === null) {
      violations.push({ code: 'missing_section', detail: `缺少分栏【${name}】` });
    } else if (isShallow(content)) {
      violations.push({ code: 'shallow_placeholder', detail: `分栏【${name}】内容为空或为占位符` });
    }
  }

  // 2. 输出侧不得出现买卖结论/收益承诺（合规红线）
  const tradeHits = scanPredictionLanguage(text);
  if (tradeHits.length > 0) {
    violations.push({
      code: 'trade_conclusion',
      detail: `正文含买卖结论或收益承诺语言：${tradeHits.join('、')}`,
    });
  }

  // 3. 角标不得编造（只能引用本轮工具实际返回的 refId）
  const cites = checkCitations(text, ctx.refIds);
  if (cites.invalid.length > 0) {
    violations.push({
      code: 'fabricated_citation',
      detail: `引用了本轮工具未返回的引用号：${cites.invalid.join('、')}`,
    });
  }

  // 4. L2 降级必须显式声明"非实时" + 抓取日期
  for (const fb of ctx.fallbackRefs) {
    const hasRealtimeDisclaimer = text.includes('非实时');
    const hasDate = text.includes(utcDate(fb.asOf));
    if (!hasRealtimeDisclaimer || !hasDate) {
      violations.push({
        code: 'missing_fallback_disclosure',
        detail: `降级数据 ${fb.refId} 未声明「非实时」与抓取日期 ${utcDate(fb.asOf)}`,
      });
    }
  }

  // 5. 真空期子问题必须在【无法验证项】里被点名（不得脑补为结论）
  const unverifiable = extractSection(text, '无法验证项') ?? '';
  for (const vq of ctx.vacuumSubQuestions) {
    const named = vq.keyword
      ? unverifiable.includes(vq.keyword)
      : unverifiable.includes(vq.question);
    if (!named) {
      violations.push({
        code: 'missing_vacuum_disclosure',
        detail: `信息真空期子问题未在【无法验证项】中说明：${vq.question}`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
