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
import { listFallbackCases } from './fallback';

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

/**
 * 从用户原话里提取标的提示（供兜底计划使用，避免标的名丢失）。
 *
 * 严格遵循 ADR-0001 补充决策 5「不猜代码」：
 * - 用户**显式写出** 6 位代码 → 采用（这是用户给的事实，不是我们的推断）；
 *   若命中仓库内预置案例，则换成其规范名便于阅读。
 * - 命中预置案例的**中文名** → 采用规范名（仓库内已知实体）。
 * - 其余一律返回 null，由调用方兜底为"该标的"。
 *   绝不为了"看起来完整"而猜一个标的名。
 */
export function extractSubjectHint(userText: string): string | null {
  const text = userText ?? '';
  const presets = listFallbackCases();

  // 1) 预置案例中文名（最长优先，避免"宁德时代"被短名截断的歧义）
  const byName = presets
    .filter((p) => text.includes(p.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (byName) return byName.name;

  // 2) 显式 6 位代码
  const code = text.match(/\b(\d{6})\b/)?.[1];
  if (code) {
    const hit = presets.find((p) => p.thscode.startsWith(code));
    return hit ? hit.name : code;
  }

  return null;
}

/**
 * 由**已到达的 data part** 推断时间轴当前进行到哪一步。
 *
 * 为什么不能在流式期间一律指向最后一步（T4 Spec 轴评审抓出的缺陷）：
 * 原实现是 `streaming ? steps.length - 1 : null`，把「正在执行」永久钉在
 * 最后一步（三栏证据对齐），其余步骤全部显示为已完成（绿点）—— 但那时
 * 工具调用其实还在进行。时间轴的「步进状态」因此是装饰性的，
 * 与真实执行进度不符，而票面明确要求展示"步进状态"。
 *
 * 改为按 part 到达情况推断，这是**可机械判定的真实信号**：
 *   - 收到 data-steps（步骤清单本身）→ 命题重构即将/正在发生
 *   - 收到 data-plan（计划已确认）→ 进入子问题核验
 *   - 收到 data-refs（工具已返回）→ 进入三栏对齐
 *   - 收到 data-contract（成稿校验完成）→ 全部完成 → null
 *
 * 注意：这是**下界近似**，不是精确进度。因为 data-steps 是在 merge 模型流
 * **之前**一次性写入的，前端无法知道「第 2 个子问题查完没」。
 * 宁可给一个诚实的下界，也不要给一个必然错误的"最后一步"。
 *
 * @returns 当前步骤下标；全部完成或无线索时返回 null。
 */
export function activeStepIndex(
  steps: readonly OrchestrationStep[],
  arrivedParts: readonly string[],
): number | null {
  if (steps.length === 0) return null;
  const arrived = new Set(arrivedParts);

  // 成稿校验完成 → 无进行中步骤
  if (arrived.has('data-contract')) return null;

  const find = (id: string): number => steps.findIndex((s) => s.id === id);

  // 工具已返回 → 三栏对齐中
  if (arrived.has('data-refs')) {
    const i = find('step-synthesis');
    return i >= 0 ? i : steps.length - 1;
  }

  // 计划已确认 → 子问题核验中（指向**第一个**子问题，而非最后一个）
  if (arrived.has('data-plan')) {
    const i = steps.findIndex((s) => s.id.startsWith('step-sub-'));
    return i >= 0 ? i : steps.length - 1;
  }

  // 步骤清单已到 → 命题重构（步骤清单整批先到，故指向重构而非合规校验）
  if (arrived.has('data-steps')) {
    const i = find('step-reframe');
    return i >= 0 ? i : 0;
  }

  return 0;
}
