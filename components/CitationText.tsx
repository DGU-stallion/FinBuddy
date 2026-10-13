'use client';

import { tokenizeCitations } from '@/lib/evidence';

/**
 * Seam 8 的渲染层：角标强制校验的 UI 落点（ADR-0002 决策 2）。
 *
 * 设计要点：
 * - **编造角标必须渲染为"引用失效"且不可点击**。校验用 lib/evidence.ts
 *   （与服务端同一实现），不信正文转述。
 * - 有效角标点击后滑出存证抽屉；失效角标是 `span`，不是 `button` ——
 *   从可交互性层面杜绝点击（不只是样式置灰）。
 * - 灰色 + 删除线 + title 提示，保证一眼可辨且可被屏幕阅读器理解。
 */
export function CitationText({
  text,
  allowedRefIds,
  onOpenRef,
  messageId,
}: {
  text: string;
  allowedRefIds: readonly string[];
  /** 打开存证抽屉。第二参为所属轮次的消息 id —— 每轮 refId 会重编号，
   *  只传 refId 会导致跨轮静默错配（见 components/EvidenceColumns.tsx 注释）。 */
  onOpenRef: (refId: string, messageId: string) => void;
  /** 本角标所属轮次的消息 id。 */
  messageId: string;
}) {
  const tokens = tokenizeCitations(text, allowedRefIds);

  return (
    <>
      {tokens.map((t, i) => {
        if (t.type === 'text') {
          return <span key={i}>{t.value}</span>;
        }
        if (!t.valid) {
          // 引用失效：非按钮，不可点击，样式上明确"此引用不可用"
          return (
            <span
              key={i}
              className="mx-0.5 cursor-not-allowed rounded border border-slate-700 bg-slate-800/60 px-1 align-super text-[10px] text-slate-500 line-through"
              title={`引用失效：${t.refId} 不在本轮工具返回的存证集合内（疑似编造）`}
              aria-label={`引用失效 ${t.refId}`}
            >
              {t.refId}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => onOpenRef(t.refId, messageId)}
            className="mx-0.5 rounded border border-sky-700/60 bg-sky-900/40 px-1 align-super text-[10px] text-sky-300 transition-colors hover:border-sky-500 hover:bg-sky-800/60"
            title={`查看存证 ${t.refId}`}
          >
            {t.refId}
          </button>
        );
      })}
    </>
  );
}
