/**
 * Seam 19: 会话切换规则（页面与 session-store 之间的判断）
 *
 * 设计要点：
 * - 把"何时落盘""标题何时被覆盖""空会话怎么回填"这类**有规则**的判断
 *   从 `app/page.tsx` 抽出来。理由与其它 seam 一致：埋在 useEffect 里的规则
 *   无法精确单测，而这三条都各有一个真实的坑（见下）。
 * - 三条规则对应三个真实故障：
 *   1) 流式途中落盘 → 刷新后看到半句回答，用户以为模型坏了；
 *   2) 无条件用首轮提问覆盖标题 → 用户自己起的名字被冲掉；
 *   3) 空会话回填 `undefined` → 页面读取时崩。
 */

/**
 * 何时把当前消息落盘。
 *
 * 关键红线：**流式中不落盘**。`submitted`（已发出、模型还没开始回）同理 ——
 * 此时落盘只会存下一个空回答。`error` 要落盘：保住已生成的部分，
 * 别让用户白等一场刷新后什么都没有。
 */
export function shouldPersist(status: string): boolean {
  return status !== 'streaming' && status !== 'submitted';
}

/** 默认标题（尚未由首轮提问命名时的占位）。 */
const DEFAULT_TITLES = new Set(['', '新对话']);

/**
 * 首轮提问后应使用的标题。
 *
 * 只在标题仍是默认值时才替换 —— 用户手动改过名就不该被冲掉
 * （否则"重命名"这个功能等于形同虚设）。
 */
export function nextTitleFrom(currentTitle: string, question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  if (q === '') return currentTitle;
  if (!DEFAULT_TITLES.has(currentTitle.trim())) return currentTitle;
  return q.length <= 20 ? q : `${q.slice(0, 20)}…`;
}

/**
 * 从会话记录里取出可回填到 UI 的消息。
 *
 * 始终返回数组：`undefined` 会让调用方（`setMessages` / `.map`）崩，
 * 而空会话是完全正常的状态。
 */
export function sessionMessagesOf(session: { messages?: unknown[] } | undefined): unknown[] {
  if (!session || !Array.isArray(session.messages)) return [];
  return session.messages;
}
