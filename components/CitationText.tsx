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
 * - 浅色主题（问财风）：有效角标用品牌蓝；失效/校验中用中性灰。
 *   角标数字沿用 text-[10px] —— 这是设计契约 R1 允许的例外
 *   （"低于 12px 只允许出现在：角标数字、图表刻度"）。
 * - **三态**（见 lib/evidence.ts 的 CitationStatus 注释）：
 *     valid 可点击；invalid 灰色删除线；pending 中性"校验中"。
 *   区分 pending 是为了避免流式期间把**合法**角标误显示为"引用失效"
 *   （data-refs 在流结束后才到达）。pending 同样不可点击，红线未松动。
 */
export function CitationText({
  text,
  allowedRefIds,
  onOpenRef,
  messageId,
  refsSettled,
}: {
  text: string;
  allowedRefIds: readonly string[];
  /** 打开存证抽屉。第二参为所属轮次的消息 id —— 每轮 refId 会重编号，
   *  只传 refId 会导致跨轮静默错配（见 components/EvidenceColumns.tsx 注释）。 */
  onOpenRef: (refId: string, messageId: string) => void;
  /** 本角标所属轮次的消息 id。 */
  messageId: string;
  /** 存证集合是否已确定（非流式 = true）。false 时未知角标显示"校验中"而非"失效"。 */
  refsSettled?: boolean;
}) {
  const tokens = tokenizeCitations(text, allowedRefIds, { refsSettled });

  return (
    <>
      {tokens.map((t, i) => {
        if (t.type === 'text') {
          return <span key={i}>{t.value}</span>;
        }
        if (!t.valid) {
          // pending：存证集合尚未到达（流式进行中）。中性样式，同样不可点击。
          if (t.status === 'pending') {
            return (
              <span
                key={i}
                className="mx-0.5 cursor-progress rounded border border-line-strong bg-page-alt px-1 align-super text-[10px] text-ink-2"
                title={`存证校验中：${t.refId} 正在等待本轮存证集合返回`}
                aria-label={`存证校验中 ${t.refId}`}
              >
                {t.refId}
              </span>
            );
          }
          // 引用失效：非按钮，不可点击，样式上明确"此引用不可用"
          return (
            <span
              key={i}
              className="mx-0.5 cursor-not-allowed rounded border border-line-strong bg-page px-1 align-super text-[10px] text-ink-2 line-through"
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
            className="mx-0.5 rounded border border-brand/30 bg-brand-bg px-1 align-super text-[10px] text-brand transition-colors hover:border-brand hover:bg-brand/10"
            title={`查看存证 ${t.refId}`}
          >
            {t.refId}
          </button>
        );
      })}
    </>
  );
}
