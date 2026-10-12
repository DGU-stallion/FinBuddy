'use client';

/**
 * 合规拦截提示（T3 的 data-compliance，ADR-0002 决策 1、6）
 *
 * 设计要点：
 * - **三种层级的文案必须不同**。`fail_closed` 是"合规校验服务不可用"，绝不能说成
 *   "您的问题违规" —— 那是 T3 code-review 抓出的真实缺陷（曾谎称用户索取买卖建议）。
 * - 机器可读的 `layer` 优先于文案：文案会改，信号不应依赖字符串嗅探。
 */

export type ComplianceLayer = 'keyword' | 'intent' | 'fail_closed';

const STYLE: Record<ComplianceLayer, { border: string; bg: string; icon: string; title: string }> = {
  keyword: {
    border: 'border-amber-800',
    bg: 'bg-amber-950/30',
    icon: '🛡️',
    title: '已转为基本面核验',
  },
  intent: {
    border: 'border-amber-800',
    bg: 'bg-amber-950/30',
    icon: '🛡️',
    title: '已转为基本面核验',
  },
  fail_closed: {
    border: 'border-slate-700',
    bg: 'bg-slate-900/50',
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
    <div className={`rounded-lg border px-4 py-3 ${s.border} ${s.bg}`}>
      <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
        <span>{s.icon}</span>
        {s.title}
      </div>
      <div className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
        {text}
      </div>
      {isFailClosed && (
        <div className="mt-2 text-[11px] text-slate-500">
          提示：这不是因为您的问题违规，而是合规校验环节未能完成。请稍后重试。
        </div>
      )}
    </div>
  );
}

/**
 * 从流式文本里剥离合规提示文案（避免与正文重复渲染）。
 * 拦截路径只有一段文本，这里直接返回空即可 —— 保留函数以便未来
 * 在正常路径中夹带合规提示时筛选。
 */
export function extractComplianceBody(text: string): string {
  return text;
}
