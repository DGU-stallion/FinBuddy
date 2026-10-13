'use client';

import { splitEvidence, type RefEntry } from '@/lib/evidence';
import { parseBodyLines, type InlineToken } from '@/lib/markdown';
import { CitationText } from './CitationText';

/**
 * Seam 8 渲染层：三栏证据卡片（票面「三列并列展示，高密度金融排版」）
 *
 * 设计要点：
 * - 三栏**始终渲染三列**，即使某栏缺失也显示"本栏缺失"——三栏的意义就是
 *   暴露证据偏斜，静默隐藏缺失栏反而掩盖问题。
 * - 栏内角标走 CitationText → 强制校验（ADR-0002 决策 2）。
 * - **正文含 Markdown**（真机输出确实写了 `**加粗**` 与 `- 列表`），
 *   按纯文本渲染会让用户看到字面星号 → 经 lib/markdown.ts 做极小子集解析。
 *   列表须逐行处理，否则 `- ` 也会原样外露。
 * - 高密度金融排版：等宽数字、紧凑行距、语义色（支持=绿、反对=红、无法验证=琥珀）。
 */

const COLUMN_STYLE: Record<string, { head: string; border: string; dot: string }> = {
  支持证据: { head: 'text-emerald-400', border: 'border-emerald-900/60', dot: 'bg-emerald-500' },
  反对证据: { head: 'text-red-400', border: 'border-red-900/60', dot: 'bg-red-500' },
  无法验证项: { head: 'text-amber-400', border: 'border-amber-900/60', dot: 'bg-amber-500' },
};

/** 渲染一段内联 token（加粗 + 角标共存）。 */
function Inline({
  tokens,
  allowed,
  onOpenRef,
}: {
  tokens: InlineToken[];
  allowed: readonly string[];
  onOpenRef: (refId: string) => void;
}) {
  return (
    <>
      {tokens.map((t, i) =>
        t.type === 'bold' ? (
          <strong key={i} className="font-semibold text-slate-200">
            {/* 加粗内部仍可能有角标，所以文本也要过角标校验 */}
            <CitationText text={t.value} allowedRefIds={allowed} onOpenRef={onOpenRef} />
          </strong>
        ) : (
          <CitationText key={i} text={t.value} allowedRefIds={allowed} onOpenRef={onOpenRef} />
        ),
      )}
    </>
  );
}

export function EvidenceColumns({
  text,
  refs,
  onOpenRef,
  /** 抽屉打开时压缩栏宽（spec：滑出时三栏流式压缩，证据与出处同屏对照）。 */
  compressed,
}: {
  text: string;
  refs: readonly RefEntry[];
  onOpenRef: (refId: string) => void;
  compressed?: boolean;
}) {
  const columns = splitEvidence(text);
  const allowed = refs.map((r) => r.refId);

  return (
    <div
      className={`grid gap-3 transition-all duration-300 ${
        compressed ? 'grid-cols-3 text-[11px]' : 'grid-cols-3'
      }`}
    >
      {columns.map((col) => {
        const style = COLUMN_STYLE[col.name] ?? {
          head: 'text-slate-400',
          border: 'border-slate-800',
          dot: 'bg-slate-500',
        };
        const missing = col.content === null;
        const empty = col.content === '';
        const lines = missing || empty ? [] : parseBodyLines(col.content!);

        return (
          <section
            key={col.name}
            className={`min-w-0 rounded-lg border bg-slate-900/30 p-3 ${style.border}`}
          >
            <header className="mb-2 flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
              <h4 className={`text-xs font-medium ${style.head}`}>{col.name}</h4>
            </header>

            {missing || empty ? (
              <p className="text-[11px] text-slate-600">
                {missing ? '本栏缺失（模型未按契约输出该分栏）' : '本栏为空'}
              </p>
            ) : (
              <ul className={`space-y-1.5 leading-relaxed text-slate-300 ${compressed ? 'text-[11px]' : 'text-xs'}`}>
                {lines.map((line, i) => (
                  <li
                    key={i}
                    className={line.type === 'li' ? 'relative pl-3' : ''}
                  >
                    {line.type === 'li' && (
                      <span className="absolute left-0 text-slate-600">•</span>
                    )}
                    <Inline tokens={line.token} allowed={allowed} onOpenRef={onOpenRef} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
