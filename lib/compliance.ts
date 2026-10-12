/**
 * Seam 2（可测部分）: 合规拦截的确定性层
 *
 * 设计要点（见 ADR-0002 决策 1）：
 * - 双保险：关键词层（确定性）+ 意图层（LLM 判断口语化索取）。
 * - 两者任一命中即拦截。
 * - fail-closed：意图判断本身抛错时保守拦截，绝不因模型故障放行违规。
 * - 不误伤研究性问题（实测发现：财务术语中的"买入/卖出"多为名词描述）。
 *
 * 这里只负责"判定是否索取买卖决策"，柔性引导话术由上层 prompt 负责。
 */

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

/** 收益承诺 / 杠杆 / 满仓类：无论如何都拦截（不含研究性歧义）。 */
const ALWAYS_FORBIDDEN = [
  '稳赚不赔',
  '保本',
  '翻倍',
  '梭哈',
  '满仓',
  '杠杆',
  '加仓',
  '减仓',
  '止损',
  '止盈',
  '建仓',
  '割肉',
  '抄底',
  '必涨',
  '必跌',
];

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
