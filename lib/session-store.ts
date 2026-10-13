/**
 * Seam 18: 会话存储（本地匿名）
 *
 * 背景（用户实测提出的缺口）：此前只有"清空上下文"，且**刷新即全部丢失** ——
 * 无法新建/切换会话、无法回看历史，不像一个成熟的对话产品。
 * spec 把"历史记录"列入 Out of Scope 但限定为「**本地匿名存储**」，
 * 故本模块只做本地持久化，不引入任何后端账号体系。
 *
 * 设计要点：
 * - **纯逻辑 + 注入式存储**：不直接摸 `localStorage`，而是接受 `StorageLike`。
 *   这样测"配额耗尽""坏 JSON""宿主不提供存储"都只是换一个替身，
 *   不需要污染全局环境，也不需要真实浏览器。
 * - **降级而非报错**：存储不可用（无痕模式/SSR/老旧浏览器）或数据损坏时，
 *   退化为**内存存储**并把错误吞掉 —— 用户应感受到"这次没记住"，
 *   而不是整页白屏。这是本模块最重要的一条。
 * - **会话强隔离**：每个会话持有自己的 messages。换会话必须看不到上一个会话
 *   的消息，否则就是 spec 明确要避免的"上一只股票的记忆污染"。
 * - **容量自限**：会话数与单会话消息数都有上限，防止长跑后撑爆配额。
 * - 匿名：不生成任何用户标识，不落盘任何可识别信息。
 */

/** 存储接口（只用到这三个方法；localStorage 天然满足）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Session {
  id: string;
  title: string;
  /** 该会话的消息序列（结构由调用方决定，本模块只做透传与截断）。 */
  messages: unknown[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionStoreOptions {
  /** 最多保留几个会话（超出淘汰最旧的）。 */
  maxSessions?: number;
  /** 单会话最多保留多少条消息（超出只留最近的）。 */
  maxMessagesPerSession?: number;
}

export const STORAGE_KEY = 'finbuddy.sessions.v1';
const DEFAULT_MAX_SESSIONS = 30;
const DEFAULT_MAX_MESSAGES = 200;
const TITLE_MAX = 20;

/** 内存兜底存储：当宿主没有 localStorage（SSR）或写入失败时使用。 */
function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/**
 * 从首轮提问派生会话标题。
 *
 * 为什么不用"新对话 1/2/3"：会话列表的价值是让用户一眼认出哪条是哪条。
 * 用首个提问的摘要远比序号有用（与 ChatGPT/问财的做法一致）。
 * 多行/多空格先压缩成一行，避免列表项被换行撑高。
 */
export function deriveSessionTitle(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  if (flat === '') return '新对话';
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX)}…`;
}

/** 生成会话 id：时间戳 + 随机后缀（本地排序用，不含任何可识别信息）。 */
function newId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface SessionStore {
  list(): Session[];
  get(id: string): Session | undefined;
  create(title?: string): Session;
  save(id: string, messages: unknown[]): void;
  /** 重命名（标题通常来自首轮提问，用户也可能想自己改）。 */
  rename(id: string, title: string): void;
  remove(id: string): void;
  clear(): void;
}

export function createSessionStore(
  storage: StorageLike | undefined,
  options: SessionStoreOptions = {},
): SessionStore {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxMessages = options.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES;

  // 存储不可用（SSR / 无痕 / 报错）→ 用内存兜底。
  // 用 try 探测一次写入，而不是只看对象是否存在 —— 有些环境对象在但写会抛。
  let backing: StorageLike;
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    backing = memoryStorage();
  } else {
    try {
      // 探测可写性（不覆盖真实数据：用后立即删）
      const probeKey = 'finbuddy.__probe';
      storage.setItem(probeKey, '1');
      storage.removeItem(probeKey);
      backing = storage;
    } catch {
      backing = memoryStorage();
    }
  }

  /**
   * 会话排序：最近更新的在前。
   *
   * 真缺陷（单测抓到两次）：
   *  a) 最初只在"从存储读"的路径排序，`writeAll` 不排 —— 一旦内存镜像命中，
   *     列表顺序就变成调用方传入的顺序，"最近使用置顶"静默失效。
   *  b) `Date.now()` 毫秒精度不足以区分同毫秒的两次写入，`updatedAt` 相同 →
   *     排序不稳定。故引入单调时间戳（见 nextTs），并加稳定次级键。
   */
  const byRecent = (a: Session, b: Session) =>
    b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

  /** 内存镜像：即使写盘失败也保证本次会话可用（降级不丢当前会话）。 */
  let cache: Session[] | null = null;

  /**
   * **单调**时间戳。
   *
   * 真缺陷（单测抓到）：`Date.now()` 的毫秒精度不足以区分同一毫秒内的两次写入 ——
   * 连续 `create()` 或 `create()` 后立刻 `save()`，两个会话的 `updatedAt`
   * **完全相同**，于是"最近使用置顶"静默失效（刚操作的会话没排到最前）。
   *
   * 修法：保证严格递增。同毫秒时在上一个值上 +1；若系统时钟被回拨，
   * 也不允许倒退（否则排序会整体错乱）。
   */
  let lastTs = 0;
  function nextTs(): number {
    const now = Date.now();
    lastTs = now > lastTs ? now : lastTs + 1;
    return lastTs;
  }

  /** 读盘后把 lastTs 抬到已存数据之上，避免时钟回拨时产生更小的时间戳。 */
  function syncClock(sessions: readonly Session[]): void {
    for (const s of sessions) {
      if (s.updatedAt > lastTs) lastTs = s.updatedAt;
      if (s.createdAt > lastTs) lastTs = s.createdAt;
    }
  }

  function readAll(): Session[] {
    if (cache) return cache;
    let parsed: unknown;
    try {
      const raw = backing.getItem(STORAGE_KEY);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // 坏 JSON（外部写坏 / 旧版本）→ 当空处理，绝不让它把页面带崩
      parsed = null;
    }
    const arr =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
        ? ((parsed as { sessions: unknown[] }).sessions as unknown[])
        : [];

    // 容错读取：缺字段补默认值（旧版本数据 / 被截断的数据）
    cache = arr
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
      .map((s) => ({
        id: typeof s.id === 'string' ? s.id : newId(),
        title: typeof s.title === 'string' ? s.title : '新对话',
        messages: Array.isArray(s.messages) ? s.messages : [],
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
      }))
      .sort(byRecent);

    syncClock(cache);
    return cache;
  }

  function writeAll(sessions: Session[]): void {
    syncClock(sessions);
    // 先排序再截断：这样"超上限淘汰最旧的"才真的是淘汰最旧的。
    // 若沿用调用方传入的顺序，淘汰掉的可能是刚用过的会话。
    const trimmed = [...sessions].sort(byRecent).slice(0, maxSessions);
    cache = trimmed;
    try {
      backing.setItem(STORAGE_KEY, JSON.stringify({ sessions: trimmed }));
    } catch {
      // 配额耗尽 / 无痕模式：保留内存镜像，本次可用，只是不被记住
    }
  }

  return {
    list: () => readAll(),

    get: (id) => readAll().find((s) => s.id === id),

    create(title = '新对话') {
      const now = nextTs();
      const session: Session = {
        id: newId(),
        title: title.trim() === '' ? '新对话' : title,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      writeAll([session, ...readAll()]);
      return session;
    },

    save(id, messages) {
      const sessions = readAll();
      // 不存在的 id 视为无操作（不凭空创建，避免调用方笔误静默造出脏会话）
      if (!sessions.some((s) => s.id === id)) return;
      const ts = nextTs();
      const next = sessions.map((s) => {
        if (s.id !== id) return s;
        // 只留最近 N 条：一条超长会话不该吃满配额
        const kept = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
        return { ...s, messages: kept, updatedAt: ts };
      });
      writeAll(next);
    },

    rename(id, title) {
      const sessions = readAll();
      if (!sessions.some((s) => s.id === id)) return;
      const ts = nextTs();
      writeAll(
        sessions.map((s) =>
          s.id === id ? { ...s, title: title.trim() === '' ? s.title : title, updatedAt: ts } : s,
        ),
      );
    },

    remove(id) {
      writeAll(readAll().filter((s) => s.id !== id));
    },

    clear() {
      writeAll([]);
    },
  };
}
