'use client';

import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deriveViews, streamingIdFromStatus } from '@/lib/message-view';
import { listFallbackCases } from '@/lib/fallback';
import { EvidenceColumns } from '@/components/EvidenceColumns';
import { EvidenceDrawer } from '@/components/EvidenceDrawer';
import { SensitivityCard } from '@/components/SensitivityCard';
import { ThinkingTimeline } from '@/components/ThinkingTimeline';
import { IntentTags, type TagEditIntent } from '@/components/IntentTags';
import { ComplianceNotice } from '@/components/ComplianceNotice';

/**
 * 问财式工作台（T4）
 *
 * 设计要点：
 * - 所有解析都在 lib/message-view.ts（纯函数、已单测），本文件只做渲染与交互编排。
 * - 角标点击滑出右侧 380px 存证抽屉；抽屉打开时三栏压缩（证据与出处同屏对照）。
 * - 降级指示灯、契约违规提示、命题兜底标注都必须显式可见（不隐藏坏消息）。
 * - 预置案例来自 lib/fallback.ts（不硬编码）。
 */

const PRESET_CASES = [
  {
    key: '300308',
    title: '中际旭创 · 大客户砍单核验',
    question: '中际旭创大客户砍单传闻导致业绩要崩，这个说法成立吗？',
    tag: '预置案例 · 真机验证',
  },
  {
    key: '300750',
    title: '宁德时代 · 固态电池量产跳票',
    question: '网传宁德时代固态电池量产跳票，公告里有相关披露吗？',
    tag: '预置案例 · 真机验证',
  },
];

export default function WorkbenchPage() {
  const [input, setInput] = useState('');
  const [openRefId, setOpenRefId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startedAt = useRef<number | null>(null);

  const { messages, sendMessage, status, error, setMessages } = useChat();

  const busy = status === 'submitted' || status === 'streaming';

  const views = useMemo(
    () =>
      deriveViews({
        messages,
        streamingMessageId: streamingIdFromStatus(status, messages),
      }),
    [messages, status],
  );

  // 计时：从提交到首个 assistant 消息出现（真实耗时，不伪造）
  useEffect(() => {
    if (busy && startedAt.current === null) {
      startedAt.current = Date.now();
      setElapsed(null);
    }
    if (!busy && startedAt.current !== null) {
      setElapsed(Date.now() - startedAt.current);
      startedAt.current = null;
    }
  }, [busy]);

  // 抽屉打开时禁止背景滚动（380px 抽屉覆盖正文）
  useEffect(() => {
    document.body.style.overflow = openRefId ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [openRefId]);

  const lastView = views.length > 0 ? views[views.length - 1] : null;
  const drawerRefs = lastView?.refs ?? [];

  const submit = useCallback(
    (text: string) => {
      const q = text.trim();
      if (q === '' || busy) return;
      sendMessage({ text: q });
      setInput('');
      setOpenRefId(null);
    },
    [busy, sendMessage],
  );

  /**
   * 标签微调后的重跑（spec 交互决策）。
   * 把变更后的意图标签作为新的提问发出 —— 复用同一轮链路，不新增服务端接口。
   */
  const rerunFromTags = useCallback(
    (intent: TagEditIntent) => {
      if (busy) return;
      const base = lastView?.plan?.reframedClaim ?? lastView?.userText ?? '';
      // 明确告知是按标签收窄后的重跑，让命题重构围绕新标签
      const text =
        intent.reason === 'delete'
          ? `请按以下意图标签重新核验（已删除「${intent.tag}」）：${intent.nextTags.join('；')}。原命题：${base}`
          : `请按修改后的意图标签重新核验：${intent.nextTags.join('；')}。原命题：${base}`;
      setOpenRefId(null);
      sendMessage({ text });
    },
    [busy, lastView, sendMessage],
  );

  /** 清空上下文（票面要求：避免上一只股票记忆污染）。 */
  const clearContext = useCallback(() => {
    setMessages([]);
    setOpenRefId(null);
    setInput('');
  }, [setMessages]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div
        className="mx-auto max-w-[1280px] px-6 py-8 transition-all duration-300"
        style={{ paddingRight: openRefId ? '404px' : undefined }}
      >
        {/* 顶栏 */}
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              FinBuddy <span className="text-slate-500">· 投资命题核验工作台</span>
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              AI 定性 + 数学定量 · 结论可追溯到原始字段 · 不提供投资建议
            </p>
          </div>
          {views.length > 0 && (
            <button
              type="button"
              onClick={clearContext}
              disabled={busy}
              className="shrink-0 rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-40"
            >
              清空上下文
            </button>
          )}
        </header>

        {/* 搜索框 */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="mb-4 flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入投资疑问或传闻，如：中际旭创大客户砍单传闻成立吗？"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm outline-none placeholder:text-slate-600 focus:border-sky-600"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || input.trim() === ''}
            className="rounded-lg bg-sky-600 px-6 py-3 text-sm font-medium hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? '核验中…' : '核验'}
          </button>
        </form>

        {/* 预置案例（零输入体验完整链路） */}
        {views.length === 0 && (
          <div className="mb-6">
            <div className="mb-2 text-[11px] text-slate-500">预置案例（一键体验完整链路）</div>
            <div className="grid grid-cols-2 gap-3">
              {PRESET_CASES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => submit(c.question)}
                  disabled={busy}
                  className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-left transition-colors hover:border-sky-800 hover:bg-slate-900 disabled:opacity-50"
                >
                  <div className="text-sm text-slate-200">{c.title}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{c.question}</div>
                  <div className="mt-2 text-[10px] text-emerald-600">{c.tag}</div>
                </button>
              ))}
            </div>
            <div className="mt-3 text-[11px] text-slate-600">
              兜底存证覆盖标的：
              {listFallbackCases()
                .map((r) => `${r.name}(${r.thscode})`)
                .join('、')}
            </div>
          </div>
        )}

        {/* 轮次列表 */}
        <div className="space-y-6">
          {views.map((v) => (
            <article key={v.messageId} className="space-y-3">
              {/* 用户提问 */}
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-lg bg-sky-950/50 px-4 py-2.5 text-sm text-sky-100">
                  {v.userText}
                </div>
              </div>

              {/* 合规拦截轮次：独立分支，不渲染三栏 */}
              {v.kind === 'compliance' && v.complianceLayer && (
                <ComplianceNotice layer={v.complianceLayer} text={v.body} />
              )}

              {/* 正常分析轮次 */}
              {v.kind === 'analysis' && (
                <>
                  <ThinkingTimeline
                    steps={v.steps}
                    activeIndex={v.streaming ? v.steps.length - 1 : null}
                    elapsedMs={v.streaming ? null : elapsed}
                  />

                  {/* 意图标签（可微调） */}
                  {v.plan && v.plan.intentTags.length > 0 && (
                    <IntentTags tags={v.plan.intentTags} disabled={busy} onRerun={rerunFromTags} />
                  )}

                  {/* 命题重构 + 兜底标注 */}
                  {v.plan && (
                    <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3">
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        命题重构
                        {v.plan.fromModel === false && (
                          <span className="rounded bg-amber-950/50 px-1.5 py-0.5 text-[10px] text-amber-400">
                            兜底命题（模型计划不可用）
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-sm leading-relaxed text-slate-200">
                        {v.plan.reframedClaim}
                      </div>
                      {v.plan.subQuestions.length > 0 && (
                        <ol className="mt-2 space-y-1">
                          {v.plan.subQuestions.map((sq, i) => (
                            <li key={i} className="text-[11px] text-slate-500">
                              {i + 1}. {sq.question}
                              <span className="ml-1 text-slate-600">
                                [{sq.verificator}]
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  )}

                  {/* 降级指示灯（L2） */}
                  {v.degraded && (
                    <div className="rounded-lg border border-amber-800 bg-amber-950/30 px-4 py-2.5 text-xs text-amber-300">
                      {v.degraded.text}
                    </div>
                  )}

                  {/* 三栏证据 */}
                  {v.body !== '' && (
                    <EvidenceColumns
                      text={v.body}
                      refs={v.refs}
                      onOpenRef={setOpenRefId}
                      compressed={openRefId !== null}
                    />
                  )}

                  {/* 契约违规提示（暴露坏消息，不静默） */}
                  {v.contract && !v.contract.ok && v.contract.violations.length > 0 && (
                    <details className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-2.5">
                      <summary className="cursor-pointer text-[11px] text-slate-500">
                        输出契约校验发现 {v.contract.violations.length} 项偏差（点击查看）
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {v.contract.violations.map((vio, i) => (
                          <li key={i} className="text-[11px] text-slate-500">
                            <span className="font-mono text-slate-600">{vio.code}</span> · {vio.detail}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {/* 敏感性测算卡片 */}
                  {v.sensitivityParams && <SensitivityCard params={v.sensitivityParams} />}

                  {/* 智能追问 */}
                  {v.followUps.length > 0 && (
                    <div>
                      <div className="mb-2 text-[11px] text-slate-500">继续核验（逻辑递进）</div>
                      <div className="flex flex-col gap-2">
                        {v.followUps.map((q, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => submit(q)}
                            disabled={busy}
                            className="rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2 text-left text-xs text-slate-300 transition-colors hover:border-sky-800 hover:bg-slate-900 disabled:opacity-50"
                          >
                            <span className="mr-2 text-slate-600">{i + 1}</span>
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 无正文但有计划（流式早期）的占位 */}
                  {v.body === '' && !v.streaming && v.steps.length === 0 && (
                    <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3 text-xs text-slate-500">
                      本轮未返回分析内容。
                    </div>
                  )}
                </>
              )}
            </article>
          ))}
        </div>

        {busy && (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
            正在核验：合规校验 → 命题重构 → 多源调数 → 三栏对齐…
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-900 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            请求失败：{error.message}
          </div>
        )}

        <footer className="mt-10 border-t border-slate-800 pt-4 text-[11px] leading-relaxed text-slate-600">
          本工具仅提供投资命题的公开信息核验与确定性算账，<span className="text-slate-500">不构成任何投资建议</span>。
          所有事实性结论均挂载存证角标，可点击查看工具返回的原始报文；编造引用会被强制标记为「引用失效」。
        </footer>
      </div>

      {/* 存证抽屉 */}
      <EvidenceDrawer
        refId={openRefId}
        refs={drawerRefs}
        onClose={() => setOpenRefId(null)}
        onNavigate={setOpenRefId}
      />
    </main>
  );
}
