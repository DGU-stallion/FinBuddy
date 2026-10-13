import { describe, it, expect } from 'vitest';
import {
  createSessionStore,
  deriveSessionTitle,
  type StorageLike,
  type Session,
} from './session-store';

/**
 * Seam 18: 会话存储（本地匿名、无后端）
 *
 * 公共接口：
 *  - createSessionStore(storage): list / get / create / save / remove / clear
 *  - deriveSessionTitle(question): 从首轮提问派生会话标题
 *
 * 抓到：刷新即丢失、无法新建/切换会话、会话之间消息串味、
 *       存储损坏（被外部写坏 JSON）导致整页崩溃、无上限增长撑爆配额。
 * 漏掉：跨设备同步（spec 明确 Out of Scope —— 只做"本地匿名存储"）。
 *
 * 关键红线：
 *  1. **存储不可用或数据损坏时必须降级到内存，绝不让界面崩**（用户可能开了
 *     无痕模式或写了脏数据；报错应该表现为"这次不记住"，而不是白屏）。
 *  2. **会话之间必须隔离** —— 换会话不得看到上一个会话的消息，
 *     否则就是"标的记忆污染"，正是 spec 要避免的。
 *  3. 匿名：不生成任何用户标识，不上报任何内容。
 */

/** 内存 Storage 替身（jsdom 的 localStorage 在测试里可复用，但显式替身更可控）。 */
function memStorage(): StorageLike & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => void raw.set(k, v),
    removeItem: (k) => void raw.delete(k),
  };
}

/** 写入坏数据的存储（模拟被外部破坏 / 旧版本格式）。 */
function corruptStorage(): StorageLike {
  return {
    getItem: () => '{"sessions": [ this is not json',
    setItem: () => {},
    removeItem: () => {},
  };
}

/** 写入时抛异常的存储（模拟配额耗尽 / 无痕模式）。 */
function throwingStorage(): StorageLike {
  return {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('QuotaExceededError');
    },
    removeItem: () => {},
  };
}

const msgs = (text: string) => [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }];

describe('基本生命周期', () => {
  it('初始为空（无会话时不伪造一个空会话）', () => {
    const s = createSessionStore(memStorage());
    expect(s.list()).toEqual([]);
  });

  it('新建 → 列表出现 → 可取回', () => {
    const s = createSessionStore(memStorage());
    const a = s.create();
    expect(s.list().map((x) => x.id)).toEqual([a.id]);
    expect(s.get(a.id)?.id).toBe(a.id);
  });

  it('新建的会话是空的（不带任何消息）', () => {
    const s = createSessionStore(memStorage());
    const a = s.create();
    expect(a.messages).toEqual([]);
  });

  it('保存消息后能读回', () => {
    const s = createSessionStore(memStorage());
    const a = s.create();
    s.save(a.id, msgs('中际旭创怎么样'));
    expect(s.get(a.id)?.messages).toHaveLength(1);
  });

  it('删除会话后不可取回', () => {
    const s = createSessionStore(memStorage());
    const a = s.create();
    s.remove(a.id);
    expect(s.get(a.id)).toBeUndefined();
    expect(s.list()).toEqual([]);
  });

  it('保存到不存在的会话 → 不抛异常，也不凭空创建', () => {
    const s = createSessionStore(memStorage());
    expect(() => s.save('nope', msgs('x'))).not.toThrow();
    expect(s.list()).toEqual([]);
  });
});

describe('持久化（刷新不丢）', () => {
  it('新 store 实例能读到上一个实例写入的会话（模拟刷新）', () => {
    const storage = memStorage();
    const s1 = createSessionStore(storage);
    const a = s1.create();
    s1.save(a.id, msgs('中际旭创怎么样'));

    const s2 = createSessionStore(storage); // 新实例 = 刷新后的页面
    expect(s2.list().map((x) => x.id)).toEqual([a.id]);
    expect(s2.get(a.id)?.messages).toHaveLength(1);
  });

  it('会话顺序稳定（最近更新的在前）', () => {
    const storage = memStorage();
    const s = createSessionStore(storage);
    const a = s.create();
    const b = s.create();
    s.save(a.id, msgs('a'));
    // a 刚被更新 → 应排在 b 前面
    expect(s.list()[0].id).toBe(a.id);
  });
});

describe('会话隔离（红线 2：不得串味）', () => {
  it('两个会话的消息互不可见', () => {
    const s = createSessionStore(memStorage());
    const a = s.create();
    const b = s.create();
    s.save(a.id, msgs('中际旭创怎么样'));
    s.save(b.id, msgs('宁德时代怎么样'));
    expect(s.get(a.id)!.messages[0]).not.toEqual(s.get(b.id)!.messages[0]);
    expect(JSON.stringify(s.get(a.id)!.messages)).toContain('中际旭创');
    expect(JSON.stringify(s.get(a.id)!.messages)).not.toContain('宁德时代');
  });

  it('删除其一会话不影响另一个', () => {
    const s = createSessionStore(memStorage());
    const a = s.create();
    const b = s.create();
    s.save(a.id, msgs('a'));
    s.save(b.id, msgs('b'));
    s.remove(a.id);
    expect(s.get(b.id)?.messages).toHaveLength(1);
  });
});

describe('标题派生', () => {
  it('短提问原样保留（不截断）', () => {
    expect(deriveSessionTitle('中际旭创怎么样')).toBe('中际旭创怎么样');
  });

  it('恰好 20 字的提问不截断（边界）', () => {
    const exactly20 = '一'.repeat(20);
    expect(deriveSessionTitle(exactly20)).toBe(exactly20);
  });

  it('超过 20 字时截断加省略号', () => {
    const q = '中际旭创大客户砍单传闻导致业绩要崩，这个说法成立吗？'; // 26 字
    expect(q.length).toBeGreaterThan(20);
    expect(deriveSessionTitle(q)).toBe('中际旭创大客户砍单传闻导致业绩要崩，这个…');
  });

  it('过长时截断并加省略号', () => {
    const long = '一'.repeat(60);
    const t = deriveSessionTitle(long);
    expect(t.length).toBeLessThanOrEqual(21); // 20 字 + 省略号
    expect(t.endsWith('…')).toBe(true);
  });

  it('多行/多空格压缩为一行', () => {
    expect(deriveSessionTitle('第一行\n\n第二行   带空格')).toBe('第一行 第二行 带空格');
  });

  it('空提问给出占位标题（不显示空白项）', () => {
    expect(deriveSessionTitle('')).toBe('新对话');
    expect(deriveSessionTitle('   ')).toBe('新对话');
  });
});

describe('健壮性（红线 1：绝不因存储问题崩页）', () => {
  it('存储里是坏 JSON → 降级为空列表，不抛异常', () => {
    expect(() => createSessionStore(corruptStorage()).list()).not.toThrow();
    expect(createSessionStore(corruptStorage()).list()).toEqual([]);
  });

  it('写入抛异常（配额耗尽/无痕）→ 不抛，且本次会话仍在内存里可用', () => {
    const s = createSessionStore(throwingStorage());
    expect(() => s.create()).not.toThrow();
    const a = s.create();
    expect(() => s.save(a.id, msgs('x'))).not.toThrow();
    // 内存里仍能读到自己刚存的（降级但不丢当前会话）
    expect(s.get(a.id)?.messages).toHaveLength(1);
  });

  it('缺少 getItem 的宿主环境（SSR / 老旧浏览器）→ 不抛异常', () => {
    expect(() => createSessionStore(undefined).list()).not.toThrow();
    expect(createSessionStore(undefined).list()).toEqual([]);
  });

  it('旧版本数据缺字段 → 容错读取，不抛异常', () => {
    const storage = memStorage();
    storage.setItem('finbuddy.sessions.v1', JSON.stringify({ sessions: [{ id: 'x' }] }));
    const s = createSessionStore(storage);
    expect(() => s.list()).not.toThrow();
    // id 在就保留，缺的字段补默认值
    expect(s.get('x')?.messages).toEqual([]);
  });
});

describe('容量上限（防撑爆配额）', () => {
  it('会话数超上限时淘汰最旧的', () => {
    const s = createSessionStore(memStorage(), { maxSessions: 3 });
    const ids = [s.create().id, s.create().id, s.create().id, s.create().id];
    const kept = s.list().map((x) => x.id);
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain(ids[0]); // 最旧的被淘汰
  });

  it('单个会话消息超上限时只留最近的（防一条超长会话吃满配额）', () => {
    const s = createSessionStore(memStorage(), { maxMessagesPerSession: 5 });
    const a = s.create();
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      parts: [{ type: 'text', text: `第${i}条` }],
    }));
    s.save(a.id, many);
    const kept = s.get(a.id)!.messages as Array<{ id: string }>;
    expect(kept).toHaveLength(5);
    // 保留的是**最近**的 5 条
    expect(kept.map((m) => m.id)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19']);
  });
});

describe('匿名性', () => {
  it('存储内容不含任何用户标识字段', () => {
    const storage = memStorage();
    const s = createSessionStore(storage);
    const a = s.create();
    s.save(a.id, msgs('中际旭创怎么样'));
    const dump = [...storage.raw.entries()].map(([k, v]) => k + v).join(' ');
    for (const f of ['userId', 'email', 'token', 'deviceId', 'ip']) {
      expect(dump).not.toContain(f);
    }
  });

  it('会话 id 不含时间戳以外的可识别信息（仅本地排序用）', () => {
    const s = createSessionStore(memStorage());
    const a: Session = s.create();
    expect(typeof a.id).toBe('string');
    expect(a.id.length).toBeGreaterThan(0);
  });
});
