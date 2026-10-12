/**
 * Seam 2（可测部分）: 合规拦截的确定性层
 *
 * 设计要点（见 ADR-0002 决策 1）：
 * - 双保险：关键词层（确定性）+ 意图层（LLM 判断口语化索取）。
 * - 两者任一命中即拦截。
 * - fail-closed：意图判断本身抛错时保守拦截，绝不因模型故障放行违规。
 * - 不误伤研究性问题（实测发现：财务术语中的"买入/卖出"多为名词描述）。
 *
 * 这里只负责"判定是否索取买卖决策"，柔性引导话术见 complianceNotice()。
 */

import { GUARANTEE_TERMS, TRADE_ACTION_TERMS } from './vocabulary';

/** 显式索取自身操作决策的句式——确定为违规，最高优先级。 */
const TRADE_SEEKING_PATTERNS: RegExp[] = [
  /买还是卖/,
  /该不该买/,
  /该不该卖/,
  /要不要买/,
  /要不要卖/,
  /能不能买/,
  /能不能卖/,
  /现在能买/,
  /现在能卖/,
  /明天买/,
  /明天卖/,
  /我该.{0,6}买/,
  /我该.{0,6}卖/,
  /跟着买/,
  /跟着卖/,
  /(推荐|给|告诉我).{0,8}(票|代码|股票)/,
];

/**
 * 研究性语境标记：出现这些词时，句中的"买入/卖出"多为术语名词而非操作指令。
 * 例：北向资金在买入吗、机构评级是买入、大股东减持卖出计划。
 */
const RESEARCH_CONTEXT_MARKERS = [
  '北向资金',
  '主力资金',
  '资金流',
  '净买入',
  '净卖出',
  '评级',
  '大股东',
  '股东',
  '减持',
  '增持',
  '机构',
  '基金持仓',
  '龙虎榜',
  '席位',
  '游资',
];

/**
 * 无任何语境歧义的词：一律拦截。
 *
 * 操作动词直接取自共享词表（lib/vocabulary.ts），避免两处各自维护而漂移
 * —— 曾因此漏掉「清仓」。#1 以外的承诺词已含在 GUARANTEE_TERMS 内。
 */
const ALWAYS_FORBIDDEN = [...TRADE_ACTION_TERMS, ...GUARANTEE_TERMS];

/** 判断句中的交易动作词是否处于研究性语境。 */
function isResearchContext(text: string): boolean {
  return RESEARCH_CONTEXT_MARKERS.some((m) => text.includes(m));
}

/** 返回命中的关键词/句式列表；空数组表示关键词层放行。 */
export function scanForbiddenPhrases(text: string): string[] {
  const hits: string[] = [];

  // 0. 显式索取自身决策：最高优先级，直接命中（即使句中含研究性词汇）
  for (const re of TRADE_SEEKING_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  if (hits.length > 0) return Array.from(new Set(hits));

  // 1. 收益承诺 / 杠杆 / 满仓类：无歧义，一律拦截
  for (const term of ALWAYS_FORBIDDEN) {
    if (text.includes(term)) hits.push(term);
  }
  if (hits.length > 0) return Array.from(new Set(hits));

  // 2. 裸"买入/卖出"：仅在非研究性语境下拦截（研究性语境中的它们是术语名词）
  if (!isResearchContext(text)) {
    for (const term of ['买入', '卖出', '建议买入', '建议卖出']) {
      if (text.includes(term)) hits.push(term);
    }
  }

  return Array.from(new Set(hits));
}

export interface ComplianceVerdict {
  blocked: boolean;
  layer: 'keyword' | 'intent' | 'fail_closed' | null;
  hits: string[];
  message?: string;
}

interface DetectOptions {
  /** 意图级判断器：返回 true 表示用户在索取买卖决策。可注入替身以便测试编排逻辑。 */
  llmJudge?: (text: string) => Promise<boolean>;
}

export async function detectTradeSeeking(
  text: string,
  options: DetectOptions = {},
): Promise<ComplianceVerdict> {
  // 第一层：确定性关键词
  const hits = scanForbiddenPhrases(text);
  if (hits.length > 0) {
    return { blocked: true, layer: 'keyword', hits };
  }

  // 第二层：意图级（口语化索取，关键词漏网的部分）
  if (options.llmJudge) {
    try {
      const seeking = await options.llmJudge(text);
      if (seeking) {
        return { blocked: true, layer: 'intent', hits: [] };
      }
    } catch (e) {
      // fail-closed：判断器故障时保守拦截，绝不放行
      return {
        blocked: true,
        layer: 'fail_closed',
        hits: [],
        message: `合规意图判断失败，已保守拦截：${(e as Error).message}`,
      };
    }
  }

  return { blocked: false, layer: null, hits: [] };
}

/**
 * 合规拦截的用户可见文案（ADR-0002 决策 1：柔性引导，不粗暴拒答）。
 *
 * 必须区分三种情形：
 * - keyword / intent：确实在索取买卖决策 → 柔性引导至基本面核验。
 * - fail_closed：**合规服务不可用**，保守拦截，绝不放行。
 *   此时绝不能拿“不提供投资建议”的话术回复用户 —— 那会让用户以为
 *   自己问了违规问题，进而不信任工具（实测踩到：DeepSeek 余额耗尽时
 *   所有正常提问都被套上违规话术）。
 */
export function complianceNotice(layer: 'keyword' | 'intent' | 'fail_closed'): string {
  if (layer === 'fail_closed') {
    return `FinBuddy 的合规校验服务暂时不可用，为保证不给您输出任何不具备约束力的投资操作信息，本次提问被保守拦下。

这不是因为您的问题违规。请稍后重试；或先换成纯基本面提问，例如：
- 「中际旭创近期的营收与毛利率是多少？」
- 「官方公告里有没有相关披露？」`;
  }

  return `FinBuddy 是中立投研工具，不提供任何投资建议、买卖指令或收益承诺。投资有风险，决策需独立。

不过，我可以和您一起核验该标的的基本面与关键传闻。您可以这样问我：
- 「中际旭创的营收与毛利率近期表现如何？」
- 「市场上有哪些关于它的传闻，官方披露了什么？」`;
}
