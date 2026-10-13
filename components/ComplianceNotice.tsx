'use client';

import type { ComplianceLayerName } from '@/lib/message-view';

/**
 * 合规拦截提示（T3 的 data-compliance，ADR-0002 决策 1、6）
 *
 * 设计要点：
 * - **三种层级的文案必须不同**。`fail_closed` 是"合规校验服务不可用"，绝不能说成
 *   "您的问题违规" —— 那是 T3 code-review 抓出的真实缺陷（曾谎称用户索取买卖建议）。
 * - 机器可读的 `layer` 优先于文案：文案会改，信号不应依赖字符串嗅探。
 */

// 复用 lib/message-view.ts 的声明，避免同一字面量联合两处维护（Standard 轴评审 #4）
export type ComplianceLayer = ComplianceLayerName;

const STYLE: Record<ComplianceLayer, { border: string; bg: string; icon: string; title: string }> = {
  keyword: {
    border: 'border-warn-border',
    bg: 'bg-warn-bg',
    icon: '🛡️',
    title: '已转为基本面核验',
  },
  intent: {
    border: 'border-warn-border',
    bg: 'bg-warn-bg',
    icon: '🛡️',
    title: '已转为基本面核验',
  },
  fail_closed: {
    border: 'border-line-strong',
    bg: 'bg-page-alt',
    icon: '⚠️',
    title: '合规校验服务暂时不可用',
  },
};

export function ComplianceNotice({
  layer,
  text,
}: {
  layer: ComplianceLayer;
  /** 服务端下发的柔性引导文案（正文）。 */
  text: string;
}) {
  const s = STYLE[layer] ?? STYLE.keyword;
  const isFailClosed = layer === 'fail_closed';

  return (
    <div className={`rounded-card border px-4 py-3 ${s.border} ${s.bg}`}>
      <div className="flex items-center gap-2 text-body font-medium text-ink-1">
        <span>{s.icon}</span>
        {s.title}
      </div>
      <div className="mt-1.5 whitespace-pre-wrap text-body leading-relaxed text-ink-2">
        {text}
      </div>
      {isFailClosed && (
        <div className="mt-2 text-aux text-ink-2">
          提示：这不是因为您的问题违规，而是合规校验环节未能完成。请稍后重试。
        </div>
      )}
    </div>
  );
}
