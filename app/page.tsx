'use client';

import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deriveViews, streamingIdFromStatus } from '@/lib/message-view';
import { listFallbackCases } from '@/lib/fallback';
import { PRESET_CASES } from '@/lib/preset-cases';
import { buildRerunText } from '@/lib/rerun';
import { activeStepIndex } from '@/lib/orchestration';
import { EvidenceColumns } from '@/components/EvidenceColumns';
import { EvidenceDrawer } from '@/components/EvidenceDrawer';
import { SensitivityCard } from '@/components/SensitivityCard';
import { ThinkingTimeline } from '@/components/ThinkingTimeline';
import { IntentTags, type TagEditIntent } from '@/components/IntentTags';
import { ComplianceNotice } from '@/components/ComplianceNotice';

/**
 * 问财风对话式页面（浅色 · 单栏对话流）
 *
 * 是什么：整个应用的唯一页面。负责把 useChat 的消息流渲染成
 * 「用户右侧浅蓝气泡 / AI 全宽白底区块」的对话流，并编排抽屉、重跑、清空等交互。
 * 所有解析都在 lib/message-view.ts（纯函数、已单测），本文件只做渲染与交互编排。
 *
 * 抓到什么（本次重做补上的三个交互，设计契约 §2.2）：
 * - B1 输入框 sticky 常驻底部：原先 <form> 在轮次列表**之前**，第二轮起输入框
 *   被内容推到视口外，要滚回顶部才能追问 —— 这是"不像聊天"的根因。
 *   现在 form 是 DOM 中最后一个区域且 `sticky bottom-0`，任何滚动位置都可直接输入。
 * - B2 自动滚动到最新：原先完全没有滚动管理，流式时新内容在视口外用户看不到进度。
 *   现在内容增长时滚到底；但用"贴底跟随"模型 —— 用户主动上滚离开底部即停止跟随，
 *   读历史不会被强行拽回（见 scrollAnchorRef/stickToBottom 注释）。
 * - B3 消息身份区分：用户 = 右侧 `bg-chat-user` 气泡；AI = 全宽白底区块。
 *   数据（三栏/表格/测算卡）一律在 AI 区块内全宽排版，**不进窄气泡**
 *   （调研 §4 反例 1：气泡 60–75% 宽会把表格字号压到不可读）。
 *
 * 漏掉什么：不做虚拟滚动（轮次少，不值得）；不做消息级编辑/重发。
 */

/** 距视口底部多少像素内视为"用户贴着底"，继续跟随新内容。 */
const STICK_THRESHOLD_PX = 80;

export default function WorkbenchPage() {
  const [input, setInput] = useState('');
  // 抽屉状态必须同时记住**哪一轮**的存证：每轮 refId 都从 ref_1 重新编号，
  // 只记 refId 会导致跨轮静默错配（点第一轮的 [^ref_1] 显示最后一轮的 payload）。
  // 见 app/page.tsx 里 drawerRefs 的注释与 tests/page-render.test.tsx 的跨轮用例。
  const [openRef, setOpenRef] = useState<{ messageId: string; refId: string } | null>(null);
  const openRefId = openRef?.refId ?? null;
  // 耗时必须**按轮次**记：原先是一个全局 elapsed 传给每一轮，
  // 导致第二轮完成后第一轮的时间轴显示第二轮的耗时（跨轮错配，Spec 轴评审指出）。
  const [elapsedByMessage, setElapsedByMessage] = useState<Record<string, number>>({});
  const startedAt = useRef<{ id: string; at: number } | null>(null);

  /**
   * **同步**提交闸门 —— 不能用 status 派生的 busy 单独把关。
   *
   * 真缺陷（用户实测）：点一次预置案例，服务端出现两次完整一轮
   * （日志 50459ms + 58260ms 背靠背）。根因是 `busy` 派生自 `useChat` 的
   * `status`，而 **state 更新是异步的** —— 第二次点击发生在重渲染之前，
   * 那一刻 `busy` 仍是 false，闸门形同虚设。
   *
   * ref 的写入是同步的，所以能在同一个 tick 内挡住后续点击。
   * `busy` 仍然保留：它负责覆盖"本轮尚未结束但用户没连点"的情况
   * （例如流式中的禁用态），两者是互补而非替代关系。
   */
  const inFlight = useRef(false);

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

  const streamingId = streamingIdFromStatus(status, messages);

  // ---------------------------------------------------------------------------
  // B2 自动滚动到最新（贴底跟随模型）
  //
  // 为什么不简单地"每次渲染都 scrollIntoView"：用户上滚读历史时会被强行拽回
  // 底部（设计契约 §2.2 明确要求"用户主动上滚时不打扰"）。
  //
  // 做法分两半：
  //  1) scroll 监听只维护一个布尔：用户当前是否贴着底部（ref，不触发重渲染）。
  //     贴底 = 跟随模式开；离开底部 = 跟随模式关（用户在自己读历史）。
  //  2) 内容增长（messages/status 变化）时，仅当跟随模式开着才滚到底。
  // 锚点用空 div + scrollIntoView 而不是 window.scrollTo：jsdom/测试环境对
  // 后者支持不一，scrollIntoView 在 jsdom 里是安全 no-op。
  // ---------------------------------------------------------------------------
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      const gap = doc.scrollHeight - (window.scrollY + window.innerHeight);
      stickToBottom.current = gap <= STICK_THRESHOLD_PX;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const anchor = scrollAnchorRef.current;
    // jsdom（测试环境）未实现 scrollIntoView —— 用 typeof 守卫而不是可选链，
    // 可选链只防 null/undefined，防不住「方法不存在」。
    if (!anchor || typeof anchor.scrollIntoView !== 'function') return;
    // behavior 用 'auto'（瞬时）而非 'smooth'：流式期间内容高频增长，
    // 平滑滚动会永远追不上尾部，反而显得卡顿。
    anchor.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [messages, status, busy]);

  // 计时：每轮从开始流式到该轮结束的**真实耗时**（不伪造），按 messageId 记账。
  useEffect(() => {
    if (streamingId) {
      if (startedAt.current?.id !== streamingId) {
        startedAt.current = { id: streamingId, at: Date.now() };
      }
      return;
    }
    const started = startedAt.current;
    if (started) {
      startedAt.current = null;
      const cost = Date.now() - started.at;
      setElapsedByMessage((prev) => ({ ...prev, [started.id]: cost }));
    }
    // 一轮结束（不再有流式消息）→ 释放同步闸门。
    // 放在这里而不是 sendMessage 之后：必须等**真实轮次结束**才放行，
    // 否则闸门只在 sendMessage 调用的那一刻有效，流式期间又变成靠 busy 把关。
    inFlight.current = false;
  }, [streamingId]);

  // 出错时必须释放闸门 —— 否则一次失败会让界面**永久无法再提交**
  // （用户只能刷新页面，而界面上没有说明）。
  useEffect(() => {
    if (error) inFlight.current = false;
  }, [error]);

  // 抽屉打开时禁止背景滚动（380px 抽屉覆盖正文）
  useEffect(() => {
    document.body.style.overflow = openRefId ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [openRefId]);

  const lastView = views.length > 0 ? views[views.length - 1] : null;
  // 抽屉的存证集合取自**打开它的那一轮**（ADR-0002 决策 4：以该轮原始 payload 为准）。
  // 取 lastView 会错配：两轮都从 ref_1 编号，点第一轮的角标会显示最后一轮的数据。
  const openView = openRef ? views.find((v) => v.messageId === openRef.messageId) ?? null : null;
  const drawerRefs = openView?.refs ?? [];

  const submit = useCallback(
    (text: string) => {
      const q = text.trim();
      // 先查同步闸门（挡同 tick 连点），再查异步 busy（挡已在进行中的轮次）
      if (q === '' || inFlight.current || busy) return;
      inFlight.current = true;
      sendMessage({ text: q });
      setInput('');
      setOpenRef(null);
      // 新一轮开始 → 强制回到跟随模式：用户刚发出提问，意图就是看最新回答。
      // 不设回 true 的话，若用户此前上滚读过历史，新一轮流式会完全不滚动。
      stickToBottom.current = true;
    },
    [busy, sendMessage],
  );

  /**
   * 标签微调后的重跑（spec 交互决策）。
   * 把变更后的意图标签作为新的提问发出 —— 复用同一轮链路，不新增服务端接口。
   */
  const rerunFromTags = useCallback(
    (intent: TagEditIntent) => {
      if (inFlight.current || busy) return;
      inFlight.current = true;
      // 重跑提问的构造规则在 lib/rerun.ts（已单测）。页面只管何时调用。
      const text = buildRerunText({
        reason: intent.reason,
        tag: intent.tag,
        nextTags: intent.nextTags,
        base: lastView?.plan?.reframedClaim ?? lastView?.userText ?? '',
      });
      setOpenRef(null);
      stickToBottom.current = true; // 同 submit：重跑等于新一轮提问
      sendMessage({ text });
    },
    [busy, lastView, sendMessage],
  );

  /** 清空上下文（票面要求：避免上一只股票记忆污染）。 */
  const clearContext = useCallback(() => {
    inFlight.current = false;
    setMessages([]);
    setElapsedByMessage({});
    setOpenRef(null);
    setInput('');
    stickToBottom.current = true;
  }, [setMessages]);

  // 抽屉打开时内容右移 380px：padding 加在 <main> 上，让顶栏/对话流/输入框
  // 整体左移（而不是只有正文移、输入框仍被抽屉盖住）。
  const drawerOffset = openRefId ? { paddingRight: '404px' } : undefined;

  return (
    <main
      className="flex min-h-screen flex-col bg-page text-ink-1 transition-[padding] duration-300"
      style={drawerOffset}
    >
      {/* 顶栏：细、不抢视觉；sticky 保证任何滚动位置都能清空上下文 */}
      <header className="sticky top-0 z-20 border-b border-line bg-chat-ai/95 backdrop-blur">
        <div className="mx-auto flex max-w-[880px] items-center justify-between gap-4 px-4 py-2.5">
          <div className="min-w-0">
            <h1 className="truncate text-card font-semibold tracking-tight text-ink-1">
              FinBuddy <span className="font-normal text-ink-2">· 投资命题核验助手</span>
            </h1>
          </div>
          {views.length > 0 && (
            <button
              type="button"
              onClick={clearContext}
              disabled={busy}
              className="shrink-0 rounded-chip border border-line-strong px-3 py-1.5 text-aux text-ink-2 transition-colors hover:border-brand hover:text-brand disabled:opacity-40"
            >
              清空上下文
            </button>
          )}
        </div>
      </header>

      {/* 对话流：单栏 880px 居中（设计契约 §2.1） */}
      <div className="mx-auto w-full max-w-[880px] flex-1 px-4 pb-8 pt-5">
        {/* 首屏空状态：紧凑推荐，不做大卡片墙（契约 §2.3：要像对话产品的空状态）。
            垂直居中而非顶格：空状态贴着顶栏会在下方留出大片空白，看起来像"页面没加载完"
            （实测截图确认）。对话产品的惯例是把空状态放在视口视觉中心。
            用 min-h + flex 居中，并留出上下 padding 避免小屏被顶栏/输入框挤到。 */}
        {views.length === 0 && (
          <div className="flex min-h-[calc(100vh-220px)] flex-col justify-center pb-10 pt-4">
            <div className="mx-auto max-w-[560px] text-center">
              <p className="text-lead text-ink-1">
                输入投资疑问或传闻，FinBuddy 会做公开信息核验与确定性算账。
              </p>
              <p className="mt-1.5 text-aux text-ink-2">
                结论可追溯到原始字段 · AI 定性 + 数学定量 · 不提供投资建议
              </p>
            </div>
            <div className="mt-6">
              <div className="mb-2 text-aux text-ink-2">预置案例（一键体验完整链路）</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {PRESET_CASES.map((c) => (
                  <button
                    key={c.thscode}
                    type="button"
                    onClick={() => submit(c.question)}
                    disabled={busy}
                    className="rounded-card border border-line bg-chat-ai px-3.5 py-2.5 text-left shadow-card transition-colors hover:border-brand hover:bg-brand-bg disabled:opacity-50"
                  >
                    <div className="text-body font-medium text-ink-1">{c.title}</div>
                    <div className="mt-0.5 line-clamp-2 text-aux leading-relaxed text-ink-2">
                      {c.question}
                    </div>
                    <div className="mt-1.5 inline-block rounded-chip bg-brand-bg px-1.5 py-0.5 text-aux text-brand">
                      {c.tag}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-3 text-aux text-ink-2">
                兜底存证覆盖标的：
                {listFallbackCases()
                  .map((r) => `${r.name}(${r.thscode})`)
                  .join('、')}
              </div>
            </div>
          </div>
        )}

        {/* 轮次列表：用户气泡（右）+ AI 全宽白底区块（B3 身份区分） */}
        <div className="space-y-6">
          {views.map((v) => (
            <article key={v.messageId} className="space-y-3">
              {/* 用户提问：右侧浅蓝气泡（实证 token chat.user #d3e0ff） */}
              <div className="flex justify-end">
                <div className="max-w-[75%] rounded-bubble bg-chat-user px-4 py-2.5 text-body leading-relaxed text-ink-1 shadow-card">
                  {v.userText}
                </div>
              </div>

              {/* 合规拦截轮次：独立分支，不渲染三栏（红线 R4） */}
              {v.kind === 'compliance' && v.complianceLayer && (
                <ComplianceNotice layer={v.complianceLayer} text={v.body} />
              )}

              {/* 正常分析轮次：AI 全宽白底区块，数据全部出气泡进卡片 */}
              {v.kind === 'analysis' && (
                <div className="space-y-4 rounded-card border border-line bg-chat-ai p-4 shadow-card sm:p-5">
                  <ThinkingTimeline
                    steps={v.steps}
                    activeIndex={
                      v.streaming
                        ? activeStepIndex(v.steps, v.arrivedParts)
                        : null
                    }
                    elapsedMs={v.streaming ? null : elapsedByMessage[v.messageId] ?? null}
                  />

                  {/* 意图标签（可微调） */}
                  {v.plan && v.plan.intentTags.length > 0 && (
                    <IntentTags tags={v.plan.intentTags} disabled={busy} onRerun={rerunFromTags} />
                  )}

                  {/* 命题重构 + 兜底标注 */}
                  {v.plan && (
                    <div className="rounded-card border border-line bg-page-alt px-4 py-3">
                      <div className="flex items-center gap-2 text-aux text-ink-2">
                        命题重构
                        {v.plan.fromModel === false && (
                          <span className="rounded-chip border border-warn-border bg-warn-bg px-1.5 py-0.5 text-aux text-warn">
                            兜底命题（模型计划不可用）
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-body leading-relaxed text-ink-1">
                        {v.plan.reframedClaim}
                      </div>
                      {v.plan.subQuestions.length > 0 && (
                        <ol className="mt-2 space-y-1">
                          {v.plan.subQuestions.map((sq, i) => (
                            <li key={i} className="text-aux text-ink-2">
                              {i + 1}. {sq.question}
                              <span className="ml-1 text-ink-2">[{sq.verificator}]</span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  )}

                  {/* 降级指示灯（L2，红线 R5：必须显著，文案与日期不得省略） */}
                  {v.degraded && (
                    <div className="rounded-card border border-warn-border bg-warn-bg px-4 py-2.5 text-body font-medium text-warn">
                      {v.degraded.text}
                    </div>
                  )}

                  {/* 三栏证据（全宽卡片，不进气泡 —— 调研 §4 反例 1） */}
                  {v.body !== '' && (
                    <EvidenceColumns
                      text={v.body}
                      refs={v.refs}
                      onOpenRef={(refId, messageId) => setOpenRef({ refId, messageId })}
                      messageId={v.messageId}
                      compressed={openRefId !== null}
                      streaming={v.streaming}
                    />
                  )}

                  {/* 契约违规提示（暴露坏消息，不静默） */}
                  {v.contract && !v.contract.ok && v.contract.violations.length > 0 && (
                    <details className="rounded-card border border-line bg-page-alt px-4 py-2.5">
                      <summary className="cursor-pointer text-aux text-ink-2">
                        输出契约校验发现 {v.contract.violations.length} 项偏差（点击查看）
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {v.contract.violations.map((vio, i) => (
                          <li key={i} className="text-aux text-ink-2">
                            <span className="font-mono">{vio.code}</span> · {vio.detail}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {/* 敏感性测算卡片 */}
                  {v.sensitivityParams && <SensitivityCard params={v.sensitivityParams} />}

                  {/* 智能追问（点击即发起下一轮） */}
                  {v.followUps.length > 0 && (
                    <div>
                      <div className="mb-2 text-aux text-ink-2">继续核验（逻辑递进）</div>
                      <div className="flex flex-col gap-2">
                        {v.followUps.map((q, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => submit(q)}
                            disabled={busy}
                            className="rounded-card border border-line bg-page-alt px-3 py-2 text-left text-body text-ink-1 transition-colors hover:border-brand hover:bg-brand-bg disabled:opacity-50"
                          >
                            <span className="mr-2 text-ink-2">{i + 1}</span>
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 无正文但有计划（流式早期）的占位 */}
                  {v.body === '' && !v.streaming && v.steps.length === 0 && (
                    <div className="rounded-card border border-line bg-page-alt px-4 py-3 text-body text-ink-2">
                      本轮未返回分析内容。
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>

        {/* 流式进行中：步骤进度提示（调研 §4 反例 4：40s 只转圈用户会刷新，
            所以这里列出确定性步骤文案，与时间轴同源而非只放一个 spinner） */}
        {busy && (
          <div className="mt-4 flex items-center gap-2 text-aux text-ink-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
            正在核验：合规校验 → 命题重构 → 多源调数 → 三栏对齐…
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-card border border-rise/30 bg-rise/5 px-4 py-3 text-body text-rise">
            请求失败：{error.message}
          </div>
        )}

        {/* 自动滚动锚点：位于对话流末尾，内容增长时滚到这里（B2） */}
        <div ref={scrollAnchorRef} aria-hidden="true" />

        {/* 完整版免责说明：留在内容流末尾（常驻精简版在底部输入区，契约 §2.1） */}
        <footer className="mt-10 border-t border-line pt-4 text-aux leading-relaxed text-ink-2">
          本工具仅提供投资命题的公开信息核验与确定性算账，不构成任何投资建议。
          所有事实性结论均挂载存证角标，可点击查看工具返回的原始报文；编造引用会被强制标记为「引用失效」。
        </footer>
      </div>

      {/* B1 输入区：sticky 常驻底部 + 常驻免责（契约 §2.1、调研 §1.1 页脚做法）。
          原先 form 在轮次列表之前（页面顶部），第二轮起要滚回顶部才能追问。 */}
      <div className="sticky bottom-0 z-20 border-t border-line bg-chat-ai/95 backdrop-blur">
        <div className="mx-auto max-w-[880px] px-4 pb-2 pt-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入投资疑问或传闻，如：中际旭创大客户砍单传闻成立吗？"
              className="flex-1 rounded-card border border-line-strong bg-chat-ai px-4 py-2.5 text-body text-ink-1 outline-none transition-colors placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/20"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || input.trim() === ''}
              className="rounded-card bg-brand px-6 py-2.5 text-body font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
            >
              {busy ? '核验中…' : '核验'}
            </button>
          </form>
          <div className="py-1.5 text-center text-aux text-ink-2">
            内容由 AI 生成，仅供研究参考，不构成投资建议
          </div>
        </div>
      </div>

      {/* 存证抽屉 */}
      <EvidenceDrawer
        refId={openRefId}
        refs={drawerRefs}
        onClose={() => setOpenRef(null)}
        onNavigate={(refId) => setOpenRef((prev) => (prev ? { ...prev, refId } : prev))}
      />
    </main>
  );
}
