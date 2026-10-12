import { describe, it, expect } from 'vitest';
import { createRefAllocator } from './refs';

/**
 * Seam: createRefAllocator() -> { next(), register(), has(), list() }
 *
 * 公共接口：本轮工具调用的引用号分配与登记。
 * 抓到：refId 唯一性（并发分配不重复）、登记后可查、未知 refId 不可查。
 * 漏掉：前端角标渲染（T4）。
 *
 * 关键（ADR-0002 决策 2）：refId 必须唯一且只引用本轮真实返回过的。
 * 实测发现的缺陷：并发工具调用时 4 次调用全部拿到 ref_1（基于 size 分配导致）。
 */

describe('createRefAllocator', () => {
  it('顺序分配时 refId 递增且唯一', () => {
    const a = createRefAllocator();
    expect(a.next()).toBe('ref_1');
    expect(a.next()).toBe('ref_2');
    expect(a.next()).toBe('ref_3');
  });

  it('注册后 has() 为真，未注册的 refId has() 为假', () => {
    const a = createRefAllocator();
    const id = a.next();
    a.register(id, { ok: true });
    expect(a.has(id)).toBe(true);
    expect(a.has('ref_999')).toBe(false);
  });

  it('并发分配不重复：先全部要号再登记，每个号仍唯一', () => {
    const a = createRefAllocator();
    // 模拟 4 个并发工具调用：全部先分配 refId（不登记）
    const ids = [a.next(), a.next(), a.next(), a.next()];
    expect(new Set(ids).size).toBe(4);
    // 然后各自登记
    ids.forEach((id, i) => a.register(id, { i }));
    expect(a.list()).toHaveLength(4);
  });

  it('未登记就分配（登记数落后于分配数）也不影响下一个号唯一', () => {
    const a = createRefAllocator();
    const first = a.next(); // 分配但不登记
    const second = a.next();
    expect(first).not.toBe(second);
  });

  it('list() 返回已登记的全部条目', () => {
    const a = createRefAllocator();
    const id1 = a.next();
    a.register(id1, { v: 1 });
    const id2 = a.next();
    a.register(id2, { v: 2 });
    expect(a.list().map((x) => x.refId)).toEqual([id1, id2]);
  });
});
