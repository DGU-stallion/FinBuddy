/**
 * Seam 7: 编排步骤时间轴（T4「思考过程时间轴」的数据源）
 *
 * 设计要点（handoff 第 6 条）：
 * 时间轴必须展示**我们自己的编排步骤**——确定性中文、由本模块生成——
 * 不得依赖模型原始推理（DeepSeek 的 thinking 倾向英文，且不稳定）。
 *
 * 因此本模块是纯函数，无模型调用、无时间依赖（真实耗时由前端计时）。
 */

import type { AnalysisPlan, Verificator } from './analysis';

export interface OrchestrationStep {
  id: string;
  label: string;
  detail: string;
}

/** 核验方的中文名（用于步骤文案）。 */
const VERIFICATOR_LABEL: Record<Verificator, string> = {
  snapshot: '行情快照',
  financials: '财务参数',
  announcements: '公告与新闻',
  unverifiable: '无法核验',
};

/**
 * 生成编排步骤清单。
 *
 * @param plan 已确认的分析计划
 * @param fromModel false 表示计划来自确定性兜底，必须显式标注（不伪装成模型产出）
 */
export function buildOrchestrationSteps(
  plan: AnalysisPlan,
  fromModel: boolean,
): OrchestrationStep[] {
  const steps: OrchestrationStep[] = [
    {
      id: 'step-compliance',
      label: '合规校验',
      detail: '关键词层 + 意图层双保险，确认本次提问为核验向而非索取买卖决策。',
    },
    {
      id: 'step-reframe',
      label: '命题重构',
      detail: `将用户输入重构为可证伪命题：${plan.reframedClaim}${
        fromModel ? '' : '（【兜底】模型计划不可用，已回退到确定性命题）'
      }`,
    },
    {
      id: 'step-tags',
      label: '意图标签',
      detail: `识别意图标签：${plan.intentTags.join('、')}`,
    },
  ];

  plan.subQuestions.forEach((sq, i) => {
    steps.push({
      id: `step-sub-${i + 1}`,
      label: `子问题核验 ${i + 1}`,
      detail: `${sq.question}（核验方：${VERIFICATOR_LABEL[sq.verificator]}）`,
    });
  });

  steps.push({
    id: 'step-synthesis',
    label: '三栏证据对齐',
    detail: '按支持 / 反对 / 无法验证三栏归类工具返回的事实，逐条挂引用号角标。',
  });

  return steps;
}

/** 存证数据源归类（供存证抽屉分组与角标着色）。 */
export type RefKind = 'snapshot' | 'financials' | 'announcements' | 'unknown';

export function refKind(payload: unknown): RefKind {
  if (typeof payload !== 'object' || payload === null) return 'unknown';
  const source = (payload as { source?: unknown }).source;
  if (typeof source !== 'string') return 'unknown';
  if (source.includes('行情')) return 'snapshot';
  if (source.includes('利润表') || source.includes('财务指标')) return 'financials';
  if (source.includes('公告')) return 'announcements';
  return 'unknown';
}
