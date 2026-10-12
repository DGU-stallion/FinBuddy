'use client';

import { useState } from 'react';
import type { OrchestrationStep } from '@/lib/orchestration';

/**
 * Seam 7 渲染层：思考过程时间轴（票面「折叠面板，展示步进状态与耗时」）
 *
 * 设计要点（handoff 第 6 条）：
 * - 步骤文案**全部来自服务端确定性产出**（`data-steps`），前端不做任何措辞加工，
 *   也不展示模型的 raw thinking（模型 thinking 倾向英文且不稳定）。
 * - 真实耗时由前端计时（服务端不伪造耗时）。
 * - 默认折叠、可展开：评委看得到"系统做了什么"，但不干扰正文阅读。
 */
export function ThinkingTimeline({
  steps,
  /** 流式进行中的当前步序（0-based）；null 表示已完成。 */
  activeIndex,
  /** 完整耗时（毫秒）；null 表示仍在进行。 */
  elapsedMs,
}: {
  steps: readonly OrchestrationStep[];
  activeIndex?: number | null;
  elapsedMs?: number | null;
}) {
  const [open, setOpen] = useState(false);

  if (steps.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-xs text-slate-400">
          <span className={`text-[10px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          思考过程
          <span className="text-slate-600">·</span>
          <span className="text-slate-500">{steps.length} 步</span>
          {activeIndex != null && activeIndex >= 0 && (
            <span className="text-sky-400">正在执行：{steps[activeIndex]?.label ?? ''}</span>
          )}
        </span>
        <span className="font-mono text-[10px] text-slate-600">
          {elapsedMs != null ? `${(elapsedMs / 1000).toFixed(1)}s` : ''}
        </span>
      </button>

      {open && (
        <ol className="space-y-0 border-t border-slate-800 px-3 py-2">
          {steps.map((s, i) => {
            const done = activeIndex == null || i < activeIndex;
            const active = activeIndex != null && i === activeIndex;
            return (
              <li key={s.id} className="flex gap-2.5 py-1.5">
                <span className="mt-1 flex flex-col items-center">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      active ? 'bg-sky-400 ring-2 ring-sky-900' : done ? 'bg-emerald-600' : 'bg-slate-700'
                    }`}
                  />
                  {i < steps.length - 1 && <span className="mt-0.5 w-px flex-1 bg-slate-800" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`text-xs ${active ? 'text-sky-300' : 'text-slate-300'}`}>
                    {s.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
                    {s.detail}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
