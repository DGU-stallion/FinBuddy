'use client';

import { summarizeRef, type RefEntry } from '@/lib/evidence';

/**
 * Seam 8 渲染层：存证抽屉（ADR-0002 决策 4）
 *
 * 设计要点：
 * - **双层展示**：默认层是人类可读摘要（服务普通用户），第二层是可折叠的完整原始
 *   JSON（满足评委下钻"回到原始字段"）。原始 JSON 直接用工具原始 payload，
 *   不信正文转述。
 * - 显著标注数据源、时间戳与实时/降级状态。
 * - 无效角标（本轮返回集合外）即使被传入也无法开抽屉 —— 抽屉内容只认原始 payload。
 */

function fmtTime(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '时点缺失';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const KIND_LABEL: Record<string, string> = {
  snapshot: '行情快照',
  financials: '财务参数',
  announcements: '公告与新闻',
  unknown: '未知数据源',
};

export function EvidenceDrawer({
  refId,
  refs,
  onClose,
  onNavigate,
}: {
  /** 当前打开的存证号；null 表示抽屉关闭。 */
  refId: string | null;
  refs: readonly RefEntry[];
  onClose: () => void;
  onNavigate: (refId: string) => void;
}) {
  const open = refId !== null;
  const entry = open ? refs.find((r) => r.refId === refId) : undefined;

  // 只有在本轮返回集合内才允许展示（ADR-0002 决策 2：抽屉数据以原始 payload 为准）
  const valid = entry !== undefined;
  const payload = valid ? (entry.payload as Record<string, unknown>) : undefined;
  const isFallback = valid && payload?.isFallback === true;
  const summary = valid ? summarizeRef(entry.payload, entry.kind) : null;

  return (
    <aside
      aria-hidden={!open}
      className={`fixed right-0 top-0 z-40 h-full w-[380px] transform border-l border-slate-800 bg-slate-950/98 shadow-2xl backdrop-blur transition-transform duration-300 ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-100">
              {valid ? `存证 ${entry.refId}` : '存证'}
            </div>
            {valid && (
              <div className="mt-0.5 text-[11px] text-slate-500">
                {KIND_LABEL[entry.kind] ?? entry.kind}
                {typeof payload?.source === 'string' ? ` · ${payload.source}` : ''}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
            aria-label="关闭存证抽屉"
          >
            关闭
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {!valid && open && (
            <div className="rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
              该引用号不在本轮工具返回的存证集合内，无法展示（疑似编造引用）。
            </div>
          )}

          {valid && summary && (
            <>
              {/* 数据源状态：实时 / 降级 必须显著 */}
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-300">
                  时点 {fmtTime(payload?.asOf)}
                </span>
                {isFallback ? (
                  <span className="rounded bg-amber-900/60 px-2 py-0.5 font-medium text-amber-200">
                    ⚠️ 降级存证 · 非实时
                  </span>
                ) : (
                  <span className="rounded bg-emerald-900/50 px-2 py-0.5 text-emerald-300">
                    实时返回
                  </span>
                )}
              </div>

              {isFallback && typeof payload?.fallbackNote === 'string' && (
                <div className="mb-3 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
                  {payload.fallbackNote}
                </div>
              )}

              {/* 默认层：人类可读摘要 */}
              <div className="mb-2 text-xs font-medium text-slate-400">{summary.title}</div>
              <dl className="space-y-2">
                {summary.fields.map((f, i) => (
                  <div key={i} className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
                    <dt className="text-[11px] text-slate-500">{f.label}</dt>
                    <dd
                      className={`mt-0.5 text-xs ${f.mono ? 'font-mono' : ''} ${
                        f.tone === 'up'
                          ? 'text-red-400'
                          : f.tone === 'down'
                            ? 'text-emerald-400'
                            : 'text-slate-200'
                      }`}
                    >
                      {f.value}
                    </dd>
                  </div>
                ))}
              </dl>

              {/* 第二层：完整原始 JSON（可折叠，满足"回到原始字段"） */}
              <details className="mt-4">
                <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">
                  查看完整原始 JSON（工具返回原文）
                </summary>
                <pre className="mt-2 max-h-[420px] overflow-auto rounded border border-slate-800 bg-black/40 p-3 text-[10px] leading-relaxed text-slate-400">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
              </details>
            </>
          )}
        </div>

        {/* 抽屉内的存证导航：三栏正文可继续点击其他角标 */}
        {valid && refs.length > 1 && (
          <footer className="border-t border-slate-800 px-4 py-3">
            <div className="mb-1.5 text-[11px] text-slate-500">本轮存证（{refs.length}）</div>
            <div className="flex flex-wrap gap-1.5">
              {refs.map((r) => (
                <button
                  key={r.refId}
                  type="button"
                  onClick={() => onNavigate(r.refId)}
                  className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                    r.refId === refId
                      ? 'border-sky-600 bg-sky-900/50 text-sky-200'
                      : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                  }`}
                >
                  {r.refId}
                </button>
              ))}
            </div>
          </footer>
        )}
      </div>
    </aside>
  );
}
