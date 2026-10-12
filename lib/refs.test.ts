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

describe('createRefAllocator list() 顺序契约', () => {
  it('乱序登记时 list() 仍按分配顺序返回', () => {
    const a = createRefAllocator();
    const r1 = a.next();
    const r2 = a.next();
    const r3 = a.next();
    const r4 = a.next();
    // 完成顺序（乱序）：2, 4, 3, 1
    a.register(r2, { v: 2 });
    a.register(r4, { v: 4 });
    a.register(r3, { v: 3 });
    a.register(r1, { v: 1 });
    expect(a.list().map((x) => x.refId)).toEqual([r1, r2, r3, r4]);
    expect(a.list().map((x) => (x.payload as { v: number }).v)).toEqual([1, 2, 3, 4]);
  });

  it('重复 register 同一 refId 不产生重复条目，且保留首次位置', () => {
    const a = createRefAllocator();
    const r1 = a.next();
    const r2 = a.next();
    a.register(r1, { v: 'first' });
    a.register(r2, { v: 2 });
    a.register(r1, { v: 'updated' });
    expect(a.list().map((x) => x.refId)).toEqual([r1, r2]);
    expect((a.list()[0].payload as { v: string }).v).toBe('updated');
  });

  it('只登记未分配过的号也不乱序（不崩）', () => {
    const a = createRefAllocator();
    const r1 = a.next();
    a.register('ref_99', { v: 99 });
    a.register(r1, { v: 1 });
    const ids = a.list().map((x) => x.refId);
    expect(ids).toContain(r1);
    expect(ids).toContain('ref_99');
  });
});
