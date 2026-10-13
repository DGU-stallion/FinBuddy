'use client';

import type { Session } from '@/lib/session-store';

/**
 * 会话侧栏（新建 / 切换 / 删除）
 *
 * 缺口（用户实测提出）：此前只有"清空上下文"，刷新即全部丢失，无法新建或
 * 切换会话 —— 不像成熟的对话产品。本组件是那个缺口的界面部分。
 *
 * 抓到：会话列表、当前项高亮、新建入口、删除入口、相对时间。
 * 漏掉：拖拽排序、会话内搜索（当前会话量级不需要）；重命名的 UI
 *       （标题自动取自首轮提问，够用；store 已支持 rename 备用）。
 *
 * 关键红线：**删除是不可逆的**，必须二次确认 —— 用户误删一整轮核验结果
 * 的代价远高于多一次点击。
 */

export interface SessionSidebarProps {
  sessions: readonly Session[];
  currentId: string | null;
  open: boolean;
  disabled: boolean;
  onNew: () => void;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

/** 相对时间：会话列表里"3 分钟前"比绝对时间戳更有用。 */
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function SessionSidebar({
  sessions,
  currentId,
  open,
  disabled,
  onNew,
  onSwitch,
  onRemove,
  onClose,
}: SessionSidebarProps) {
  return (
    <>
      {/* 遮罩：仅窄屏需要（宽屏侧栏常驻，不挡内容） */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-ink-1/20 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="会话列表"
        // 高度用 h-screen（而非 h-full）：
        // h-full 要求父元素有确定高度，而父级是 min-h-screen 的 flex 容器，
        // 并没有确定高度 —— 实测侧栏只有内容高度（151px），下方露出大片空白。
        // 宽屏用 sticky top-0 让侧栏随页面滚动固定在视口（它比主内容短时才需要）。
        className={`fixed left-0 top-0 z-30 flex h-screen w-[260px] shrink-0 flex-col border-r border-line bg-chat-ai transition-transform duration-200 lg:sticky lg:z-auto lg:translate-x-0 ${
          open ? 'translate-x-0 shadow-pop' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <span className="text-aux font-medium text-ink-2">对话</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onNew}
              disabled={disabled}
              title="新建对话"
              className="rounded-chip px-2 py-1 text-aux text-brand transition-colors hover:bg-brand-bg disabled:opacity-40"
            >
              ＋ 新建
            </button>
            <button
              type="button"
              onClick={onClose}
              title="收起"
              className="rounded-chip px-2 py-1 text-aux text-ink-2 transition-colors hover:bg-page lg:hidden"
            >
              ✕
            </button>
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-aux text-ink-2">还没有对话</p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((s) => {
                const active = s.id === currentId;
                return (
                  <li key={s.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => onSwitch(s.id)}
                      disabled={disabled}
                      aria-current={active ? 'true' : undefined}
                      className={`w-full rounded-card px-2.5 py-2 pr-7 text-left transition-colors disabled:opacity-50 ${
                        active ? 'bg-brand-bg text-brand' : 'text-ink-1 hover:bg-page'
                      }`}
                    >
                      <div className="truncate text-body">{s.title}</div>
                      <div className="mt-0.5 text-[10px] text-ink-2">
                        {relTime(s.updatedAt)}
                        {s.messages.length > 0 && ` · ${s.messages.length} 条`}
                      </div>
                    </button>
                    {/* 删除：hover 才出现，避免列表视觉噪音。
                        二次确认用原生 confirm —— 简单可靠，且用户熟悉该交互。 */}
                    <button
                      type="button"
                      title="删除对话"
                      disabled={disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`删除对话「${s.title}」？此操作不可撤销。`)) {
                          onRemove(s.id);
                        }
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 text-aux text-ink-2 opacity-0 transition-opacity hover:text-rise focus:opacity-100 group-hover:opacity-100 disabled:opacity-0"
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t border-line px-3 py-2 text-[10px] leading-relaxed text-ink-2">
          对话记录仅保存在本机浏览器（本地匿名，不上传）。
        </div>
      </aside>
    </>
  );
}
