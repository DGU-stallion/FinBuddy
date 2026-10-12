/**
 * Seam 2（可测部分）: 合规拦截的确定性层
 *
 * 设计要点（见 ADR-0002 决策 1）：
 * - 双保险：关键词层（确定性）+ 意图层（LLM 判断口语化索取）。
 * - 两者任一命中即拦截。
 * - fail-closed：意图判断本身抛错时保守拦截，绝不因模型故障放行违规。
 *
 * 这里只负责"判定是否索取买卖决策"，柔性引导话术由上层 prompt 负责
 * （不粗暴拒答是产品要求，但判定必须是硬的）。
 */

/** 确定性关键词：指令性动词、收益承诺、杠杆满仓等。 */
const FORBIDDEN_TERMS = [
  '建议买入',
  '建议卖出',
  '立即建仓',
  '建议加仓',
  '果断割肉',
  '满仓买入',
  '稳赚不赔',
  '必翻倍',
  '买入',
  '卖出',
  '加仓',
  '减仓',
  '止损',
  '止盈',
  '满仓',
  '梭哈',
  '割肉',
  '抄底',
  '杠杆',
  '翻倍',
  '保本',
  '建仓',
];

/** 口语化"索取买卖决策"的句式（确定性可识别的一部分）。 */
const FORBIDDEN_PATTERNS: RegExp[] = [
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
];

/** 返回命中的关键词/句式列表；空数组表示关键词层放行。 */
export function scanForbiddenPhrases(text: string): string[] {
  const hits: string[] = [];
  for (const term of FORBIDDEN_TERMS) {
    if (text.includes(term)) hits.push(term);
  }
  for (const re of FORBIDDEN_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
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
