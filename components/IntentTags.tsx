'use client';

import { useState } from 'react';

/**
 * Seam 11: 意图标签微调（spec 交互决策）
 *
 * 设计要点（spec 交互决策，票面明确）：
 * - **删除标签 → 自动重新分析**（删除是明确的收窄动作，语义无歧义，不必二次确认）。
 * - **修改标签文本 → 需点确认才重新分析**（避免每敲一个字调一次付费 API）。
 *   这是产品决策里最容易被实现错的一条：若 onChange 直接触发重跑，一次改名会打 8 次模型。
 *
 * 因此本组件不自己发请求，只把"意图"抛给父组件（onRerun），由父组件决定
 * 往流里塞什么。这样"何时重跑"的规则可以单测。
 *
 * 浅色主题：标签按类别着色（标的=品牌蓝 / 事件=琥珀 / 核验维度=绿），
 * 均用浅底+深色文字的组合保证白底对比度。
 */

export interface TagEditIntent {
  /** 触发重跑的原因（供父组件构造追问文本 / 埋点）。 */
  reason: 'delete' | 'edit-confirmed';
  /** 删除时是被删标签；编辑时是改后的标签。 */
  tag: string;
  /** 重跑时要替换的标签集合（已应用本次变更）。 */
  nextTags: string[];
}

/** 标签形态：`标的: 中际旭创` / `事件: 大客户砍单传闻`。 */
export function tagKind(tag: string): { kind: string; value: string } {
  const m = tag.match(/^([^:：]+)\s*[:：]\s*(.*)$/);
  if (!m) return { kind: '标签', value: tag };
  return { kind: m[1].trim(), value: m[2].trim() };
}

const KIND_STYLE: Record<string, string> = {
  标的: 'border-brand/30 bg-brand-bg text-brand',
  事件: 'border-warn-border bg-warn-bg text-warn',
  核验维度: 'border-fall/30 bg-fall/10 text-fall',
};

export function IntentTags({
  tags,
  disabled,
  onRerun,
}: {
  tags: readonly string[];
  disabled?: boolean;
  onRerun: (intent: TagEditIntent) => void;
}) {
  /** 正在编辑的标签索引；null 表示无编辑中。 */
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  function startEdit(i: number, tag: string) {
    setEditingIndex(i);
    setDraft(tag);
  }

  function cancelEdit() {
    setEditingIndex(null);
    setDraft('');
  }

  /** 确认编辑：此时才重跑（spec：修改文本需点确认）。 */
  function confirmEdit(i: number) {
    const next = draft.trim();
    if (next === '' || next === tags[i]) {
      cancelEdit();
      return;
    }
    const nextTags = tags.map((t, idx) => (idx === i ? next : t));
    setEditingIndex(null);
    setDraft('');
    onRerun({ reason: 'edit-confirmed', tag: next, nextTags });
  }

  /** 删除：立即重跑（spec：删除标签自动重新分析）。 */
  function remove(i: number) {
    const nextTags = tags.filter((_, idx) => idx !== i);
    onRerun({ reason: 'delete', tag: tags[i], nextTags });
  }

  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-aux text-ink-2">意图标签</span>
      {tags.map((tag, i) => {
        const { kind, value } = tagKind(tag);
        const style = KIND_STYLE[kind] ?? 'border-line-strong bg-page-alt text-ink-2';

        if (editingIndex === i) {
          return (
            <span key={i} className={`flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-aux ${style}`}>
              <span className="opacity-70">{kind}:</span>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmEdit(i);
                  if (e.key === 'Escape') cancelEdit();
                }}
                aria-label={`编辑标签 ${kind}`}
                className="w-40 bg-transparent text-ink-1 outline-none"
              />
              {/* 点确认才重跑 */}
              <button
                type="button"
                onClick={() => confirmEdit(i)}
                disabled={disabled}
                className="rounded-chip bg-brand px-1.5 py-0.5 text-aux text-white hover:bg-brand-hover disabled:opacity-40"
              >
                确认并重跑
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                className="px-1 text-aux text-ink-2 hover:text-ink-1"
              >
                取消
              </button>
            </span>
          );
        }

        return (
          <span key={i} className={`flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-aux ${style}`}>
            <span className="opacity-70">{kind}:</span>
            <button
              type="button"
              onClick={() => startEdit(i, tag)}
              disabled={disabled}
              className="hover:underline disabled:opacity-60"
              title="点击修改（需确认才重新分析）"
            >
              {value}
            </button>
            <button
              type="button"
              onClick={() => remove(i)}
              disabled={disabled}
              className="ml-0.5 text-ink-2 hover:text-rise disabled:opacity-40"
              aria-label={`删除标签 ${tag}`}
              title="删除标签（立即重新分析）"
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
