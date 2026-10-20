/**
 * Seam 5: 输出契约校验（T3「强制三栏输出」「无买卖结论」「降级与真空期声明」）
 *
 * 设计要点：
 * - 契约校验是模型成稿之后的**最后一道确定性防线**：它只做可机械判定的
 *   结构检查，**只负责发现与报告**。修复与强制由 T4 前端（角标灰标、
 *   降级/真空期角标）与上层策略决定：本模块不修改正文。
 * - 三栏必须存在且内容非空（占位符"无/暂无/待补充"视为空 —— 三栏不得糊弄）。
 * - 输出侧买卖语言扫描复用 lib/analysis.ts（与输入侧 lib/compliance.ts 互补）。
 * - 角标校验复用 lib/citations.ts（与 T4 前端同一实现，避免规则漂移）。
 * - 工具确实返回了数据时，正文必须至少挂一个角标：否则结论无法回溯到原始字段。
 * - L2 降级必须显式声明"非实时"+ 抓取日期；L3 真空期子问题必须在
 *   【无法验证项】里被点名（ADR-0001 决策 2：不得脑补）。
 */

import { checkCitations } from './citations';
import { scanPredictionLanguage } from './analysis';
import { utcDate } from './format';

/** 契约要求存在的分栏（顺序无关，仅校验存在性）。 */
export const REQUIRED_SECTIONS = ['命题重构', '支持证据', '反对证据', '无法验证项'] as const;

/** 视为"空栏"的占位符（模型偷懒时的常见写法）。 */
const PLACEHOLDER_RE = /^(无|暂无|没有|待补充|待核验|n\/?a|none|-+|—+|。|\.)$/i;

/**
 * 真空期状态词：出现其一才算如实声明了"这里查不到"。
 * 防止模型把信息真空期写成正常结论（ADR-0001 决策 2：LLM 不得翻案）。
 */
const VACUUM_STATE_MARKERS = [
  '信息真空期',
  '真空期',
  '无法核验',
  '无法验证',
  '未检索到',
  '检索未返回',
  '检索为空',
  '未返回结果',
  '无检索结果',
  '未披露',
  '未查询到',
  '查无',
];

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
  /**
   * 本轮数值对账的结论（来自 lib/reconcile.ts）。
   *
   * 为什么放在契约层：对账发生在**证据装配**时（模型动笔之前），
   * 而“拒绝交付”是**成稿**时的决策。二者需在这里汇合 ——
   * 否则对账器就只是又一个“只报告、没人管”的模块。
   */
  reconciliation?: ReconciliationFinding[];
}

/**
 * 对账结论的契约层视图。
 *
 * 刻意**不** import `lib/reconcile.ts` 的类型：契约层只关心
 * “有没有被拦下的结论”，不应对对账器的内部结构形成依赖
 * （对账规则会演进，契约的形状不应随之漂移）。
 */
export interface ReconciliationFinding {
  code: string;
  severity: 'block' | 'warn' | 'info';
  claim: string;
  detail: string;
}

/**
 * 正文中声明“某项数据未通过对账、不得采信”的措辞特征。
 *
 * 用于反向检查：被对账拦掉的数据，**不得**被正文当成已验证事实陈述。
 * 这个方向比“缺少声明”更危险 —— 前面几项是“该说的没说”，
 * 这一项是“把不可信的输入说成可信的”。
 */
const RECONCILIATION_MARKERS = ['对账', '未通过', '口径不符', '口径存疑', '不可采信', '数据异常'];

export type ViolationCode =
  | 'missing_section'
  | 'shallow_placeholder'
  | 'trade_conclusion'
  | 'fabricated_citation'
  | 'no_citations'
  | 'missing_fallback_disclosure'
  | 'missing_vacuum_disclosure'
  | 'data_reconciliation_failed'
  | 'reconciled_data_asserted';

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

  // 3b. 工具确实返回了数据时，正文必须至少挂一个角标（结论必须能回溯到字段）。
  // 反向情形（工具全挂、无任何 refId）不报违规：那正文本就无事实可引。
  if (!cites.hasAny && ctx.refIds.length > 0) {
    violations.push({
      code: 'no_citations',
      detail: '工具已返回数据，但正文未挂任何 [^ref_X] 角标，结论无法回溯到原始字段',
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
    if (!isVacuumDeclared(unverifiable, vq)) {
      violations.push({
        code: 'missing_vacuum_disclosure',
        detail: `信息真空期子问题未在【无法验证项】中说明：${vq.question}`,
      });
    }
  }

  // 6. 数值对账：**block 级结论即违规**（这一项让对账真正具备了强制力）。
  //
  // 为什么只有 block：warn 是“可疑，需确认”，把它升级为拒付会把闸门变成噪音，
  // 而一旦用户学会忽略告警，真正致命的 block 也会被一并忽略。
  const blocked = (ctx.reconciliation ?? []).filter((f) => f.severity === 'block');
  for (const f of blocked) {
    violations.push({
      code: 'data_reconciliation_failed',
      detail: `${f.code}：${f.claim} —— ${f.detail}`,
    });
  }

  // 6b. 反向检查：被对账拦掉的数据，不得被正文当成已验证事实陈述。
  // 只在下游真的产出正文时才检查（正文为空说明流已中断，由其他规则处理）。
  if (blocked.length > 0 && text.trim() !== '' && !hasReconciliationDisclosure(text)) {
    violations.push({
      code: 'reconciled_data_asserted',
      detail:
        `本轮有 ${blocked.length} 项数据未通过数值对账（${blocked.map((f) => f.code).join('、')}），` +
        `但正文未声明该数据不可采信。被拦下的数据必须显式归入【无法验证项】，不得作为事实陈述。`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/** 正文是否声明了“某项数据未通过对账”。 */
function hasReconciliationDisclosure(text: string): boolean {
  return RECONCILIATION_MARKERS.some((m) => text.includes(m));
}

/**
 * 真空期是否已在【无法验证项】中被说明。
 *
 * 两个条件都满足才算已声明（ADR-0001 决策 2：不得脑补）：
 *  1. **提到了该子问题的主题**：不要求整串字面匹配 —— 真机发现检索 keyword
 *     形如 "客户 订单"（空格连接的检索用词），而模型写的是自然语言，
 *     整串匹配必然误报。改用最长公共子串，只要有一段足够长的重合即可。
 *  2. **声明了真空期状态**：必须出现"真空/无法核验/未披露/无结果"这类状态词。
 *     否则模型可以把真空期写成正常结论（"客户与订单情况已在公告中有所体现"），
 *     主题词重合却把脑补伪装成已声明。
 *
 * 注意：这是"是否如实声明"的机械判定，不是语义判定。宁可略宽松地认主题词，
 * 也不能因此放过未声明真空期的脑补（假负面比假阳性危险得多）。
 */
function isVacuumDeclared(
  unverifiable: string,
  vq: { question: string; keyword?: string },
): boolean {
  return vacuumStateDeclared(unverifiable) && vacuumTopicMentioned(unverifiable, vq);
}

/** 是否显式声明了"这里查不到"的状态。 */
function vacuumStateDeclared(unverifiable: string): boolean {
  return VACUUM_STATE_MARKERS.some((m) => unverifiable.includes(m));
}

/** 是否提到了该子问题的主题（容错匹配，不要求整串字面一致）。 */
function vacuumTopicMentioned(
  unverifiable: string,
  vq: { question: string; keyword?: string },
): boolean {
  const kw = vq.keyword?.trim();
  if (kw) {
    const terms = kw.split(/[\s、,，/|]+/).filter((t) => t.length > 0);
    if (terms.length > 0 && terms.some((t) => longestCommonSubstring(unverifiable, t) >= 2)) {
      return true;
    }
    // keyword 整串也可能是连续词（无分隔符），补一次整串判定
    if (longestCommonSubstring(unverifiable, kw) >= 2) return true;
  }
  return longestCommonSubstring(unverifiable, vq.question.trim()) >= 3;
}

/** 两个字符串的最长公共子串长度（中文按 code unit 计）。 */
function longestCommonSubstring(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  let best = 0;
  // 滚动一维 DP：prev[j] = 以 a[i-1]、b[j-1] 结尾的公共子串长度
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}
