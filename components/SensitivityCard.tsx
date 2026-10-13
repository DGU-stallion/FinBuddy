'use client';

import { useMemo, useState } from 'react';
import {
  computeSensitivity,
  describeBasis,
  revenueDeclineRange,
  SLIDER_MAX_PCT,
  SLIDER_MIN_PCT,
  type SensitivityInjectParams,
} from '@/lib/sensitivity';
import { toYi as yi } from '@/lib/format';

/**
 * Seam 9 渲染层：营收冲击推演滑块卡片（ADR-0001 决策 1，spec 交互决策）
 *
 * 设计要点：
 * - **零 LLM 参与**：拖动滑块只触发 React state 更新 → 纯函数重算，不发任何网络请求。
 *   这是「AI 定性 + 数学定量」的可视化落点。
 * - 模型简化声明必须显式展示（线性一阶近似；无固定成本摊薄、无产能再分配）。
 * - 阈值区间随数值联动变色，让"冲击有多大"一眼可读。
 * - 参数缺失时明确不可测算，而不是显示 0（那会被读成"没有影响"）。
 * - 参数缺失时明确不可测算，而不是显示 0（那会被读成"没有影响"）。
 *
 * 颜色纪律（红线 R3）：这里表达的是"冲击严重程度"，不是行情涨跌，
 * 所以严重档用 rise 红（红=风险，中文金融语境直觉一致），轻微档用 fall 绿；
 * 三栏证据方向色（evidence.*）与此无关，不混用。
 */

/** 冲击占原净利润的比例 → 颜色档（严重程度梯度：绿→琥珀→橙→红）。 */
function severityTone(ratioPct: number): { bar: string; text: string; label: string } {
  if (ratioPct < 8) return { bar: 'bg-fall', text: 'text-fall', label: '轻微' };
  if (ratioPct < 15) return { bar: 'bg-warn-border', text: 'text-warn', label: '中等' };
  if (ratioPct < 22) return { bar: 'bg-orange-500', text: 'text-orange-700', label: '显著' };
  return { bar: 'bg-rise', text: 'text-rise', label: '严重' };
}

export function SensitivityCard({ params }: { params: SensitivityInjectParams | null }) {
  const [declinePct, setDeclinePct] = useState(15);

  const result = useMemo(
    () =>
      params
        ? computeSensitivity({
            baseRevenue: params.baseRevenue,
            netMargin: params.netMargin,
            taxRate: params.taxRate,
            declinePct,
          })
        : null,
    [params, declinePct],
  );

  if (!params) {
    return (
      <section className="rounded-card border border-line bg-page-alt p-4">
        <h3 className="text-card font-medium text-ink-1">营收冲击推演</h3>
        <p className="mt-2 text-body text-ink-2">
          本轮未取得可测算的财务参数（基准营收 / 净利率 / 所得税率），无法进行确定性算账。
          请先让系统调取该标的的财务数据。
        </p>
      </section>
    );
  }

  const tone = result?.ok ? severityTone(result.impactRatioPct) : null;
  // 滑块位置百分比（用于色带填充宽度）
  const fillPct =
    ((declinePct - SLIDER_MIN_PCT) / (SLIDER_MAX_PCT - SLIDER_MIN_PCT)) * 100;

  return (
    <section className="rounded-card border border-line bg-chat-ai p-4 shadow-card">
      <div className="flex items-baseline justify-between">
        <h3 className="text-card font-medium text-ink-1">营收冲击推演</h3>
        <span className="text-aux text-ink-2">确定性公式 · 零模型参与</span>
      </div>

      {/* 结果区 */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-card border border-line bg-page-alt px-3 py-2.5">
          <div className="text-aux text-ink-2">净利润冲击</div>
          <div className={`mt-1 font-mono text-kpi ${tone ? tone.text : 'text-ink-2'}`}>
            {result?.ok ? `−${yi(result.impact)}` : '不可测算'}
          </div>
          {result?.ok && (
            <div className="mt-0.5 text-aux text-ink-2">
              占原净利润 {result.impactRatioPct.toFixed(2)}% · {tone?.label}
            </div>
          )}
        </div>
        <div className="rounded-card border border-line bg-page-alt px-3 py-2.5">
          <div className="text-aux text-ink-2">原净利润（税后 · 基线）</div>
          <div className="mt-1 font-mono text-kpi text-ink-1">
            {result?.ok ? yi(result.baselineNetProfit) : '不可测算'}
          </div>
          {result?.ok && (
            <div className="mt-0.5 text-aux text-ink-2">
              下滑后剩余 {yi(result.baselineNetProfit - result.impact)}
            </div>
          )}
        </div>
      </div>

      {/* 滑块 */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between text-body">
          <label htmlFor="decline-slider" className="text-ink-2">
            营收整体下滑幅度
          </label>
          <span className={`font-mono ${tone ? tone.text : 'text-ink-1'}`}>
            {declinePct.toFixed(0)}%
          </span>
        </div>
        <div className="relative mt-2">
          {/* 联动色带 */}
          <div className="pointer-events-none absolute left-0 top-1/2 h-1 w-full -translate-y-1/2 rounded bg-line" />
          <div
            className={`pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded transition-colors ${
              tone?.bar ?? 'bg-line-strong'
            }`}
            style={{ width: `${fillPct}%` }}
          />
          <input
            id="decline-slider"
            type="range"
            min={SLIDER_MIN_PCT}
            max={SLIDER_MAX_PCT}
            step={1}
            value={declinePct}
            onChange={(e) => setDeclinePct(Number(e.target.value))}
            className="relative w-full cursor-pointer appearance-none bg-transparent"
            aria-label="营收整体下滑幅度百分比"
            aria-valuemin={SLIDER_MIN_PCT}
            aria-valuemax={SLIDER_MAX_PCT}
            aria-valuenow={declinePct}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-ink-3">
          <span>{revenueDeclineRange().min}%（轻微）</span>
          <span>{revenueDeclineRange().max}%（严重）</span>
        </div>
      </div>

      {/* 口径标注（ADR-0001 决策 4：不得静默换口径） */}
      <div className="mt-3 border-t border-line pt-3">
        <div className="text-aux text-ink-2">
          {describeBasis({
            // 不再用 as never：类型已收窄为 RevenueBasisLike | string，
            // describeBasis 内部对未知口径有 '?? 缺失' 兜底（Standard 轴评审 #8）。
            revenueBasis: params.revenueBasis,
            report: params.report,
            asOf: params.asOf,
          })}
        </div>
        <div className="mt-1 text-aux text-ink-2">
          参数溯源：<span className="font-mono text-ink-1">[{params.refId}]</span>
          （基准营收 {yi(params.baseRevenue)} · 净利率 {params.netMargin.toFixed(2)}% · 有效所得税率{' '}
          {params.taxRate.toFixed(2)}%（由利润表推导：Σ所得税费用 ÷ Σ税前利润））
        </div>
      </div>

      {/* 模型简化声明（票面硬性要求） */}
      <div className="mt-3 rounded-card border border-line bg-page px-3 py-2">
        <div className="text-aux font-medium text-ink-2">模型简化声明</div>
        <p className="mt-1 text-aux leading-relaxed text-ink-2">
          本测算为<span className="text-ink-1">线性一阶近似</span>：仅刻画营收下滑按当前净利率等比传导至净利润。
          未建模固定成本摊薄、产能再分配、产品结构变化、减值与汇兑等二阶效应，
          亦未考虑管理费用与研发投入的刚性。因此<span className="text-ink-1">不构成精确盈利预测</span>，
          仅用于理解量级与敏感性方向。
        </p>
      </div>
    </section>
  );
}
