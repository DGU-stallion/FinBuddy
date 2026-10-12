import { describe, it, expect } from 'vitest';
import { lookupStockSnapshot, searchAnnouncementsAndNews, type GatewayDeps } from './gateway';

/**
 * Seam: 网关三级降级（L1 → L2 → L3）
 *
 * 公共接口：三个工具函数在注入的 L1 调用器失败时的行为。
 * 抓到：降级触发条件、L2 标记、L3 真空信号、案例边界。
 * 漏掉：真实 API 的网络行为（集成测试覆盖）。
 *
 * 关键红线（ADR-0001 决策 2、3）：
 * - L1 失败且是预置案例 → L2，必须标记 isFallback + 抓取日期
 * - L1 失败且非预置案例 → 抛出（上层转 L3），绝不猜数据
 * - 公告检索失败或为空 → vacuum: true，绝不伪造公告
 */

const failing = (async () => {
  throw new Error('L1 down');
}) as unknown as GatewayDeps['fuyao'];

const failingIfind = (async () => {
  throw new Error('iFinD down');
}) as unknown as GatewayDeps['ifind'];

describe('lookupStockSnapshot 降级', () => {
  it('L1 成功时返回实时数据且 isFallback=false', async () => {
    const fuyao = (async (tool: string) => {
      if (tool === 'get_a_share_prices_snapshot')
        return { item: [{ thscode: '300308.SZ', last_price: 700, price_change_ratio_pct: -1, turnover: 1 }] };
      return { item: [{ thscode: '300308.SZ', name: '中际旭创', pe_ttm: 40, pb_mrq: 20 }] };
    }) as unknown as GatewayDeps['fuyao'];

    const snap = await lookupStockSnapshot('300308.SZ', 'ref_1', { fuyao, ifind: failingIfind });
    expect(snap.isFallback).toBe(false);
    expect(snap.data.last_price).toBe(700);
    expect(snap.refId).toBe('ref_1');
  });

  it('L1 失败且是预置案例时降级到 L2，并带抓取日期标注', async () => {
    const snap = await lookupStockSnapshot('300308.SZ', 'ref_2', {
      fuyao: failing,
      ifind: failingIfind,
    });
    expect(snap.isFallback).toBe(true);
    expect(snap.fallbackNote).toContain('2026-10-12');
    expect(snap.source).toContain('L2');
    expect(snap.data.last_price).toBe(724.47); // 真实抓取值
  });

  it('L1 失败且非预置案例时抛出，绝不猜数据（由上层转 L3）', async () => {
    await expect(
      lookupStockSnapshot('000001.SZ', 'ref_3', { fuyao: failing, ifind: failingIfind }),
    ).rejects.toThrow();
  });
});

describe('searchAnnouncementsAndNews 降级', () => {
  it('iFinD 不可用时返回 vacuum=true，绝不伪造公告', async () => {
    const res = await searchAnnouncementsAndNews('中际旭创', '订单', 'ref_4', 400, {
      fuyao: failing,
      ifind: failingIfind,
    });
    expect(res.vacuum).toBe(true);
    expect(res.items).toEqual([]);
  });

  it('检索结果为空时同样标记 vacuum', async () => {
    const ifind = (async () => ({ code: 1, msg: 'success', data: '[]' })) as unknown as GatewayDeps['ifind'];
    const res = await searchAnnouncementsAndNews('中际旭创', '订单', 'ref_5', 400, {
      fuyao: failing,
      ifind,
    });
    expect(res.vacuum).toBe(true);
    expect(res.items).toEqual([]);
  });

  it('有结果时解析出标题/片段/日期且 vacuum=false', async () => {
    const ifind = (async () => ({
      code: 1,
      msg: 'success',
      data: JSON.stringify([
        { 公告标题: '中际旭创：2026中期报告', 公告片段内容: '海外业务收入增长209.9%', 日期: '2026-09-11' },
      ]),
    })) as unknown as GatewayDeps['ifind'];

    const res = await searchAnnouncementsAndNews('中际旭创', '订单', 'ref_6', 400, {
      fuyao: failing,
      ifind,
    });
    expect(res.vacuum).toBe(false);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].title).toContain('中际旭创');
    expect(res.items[0].date).toBe('2026-09-11');
  });
});
