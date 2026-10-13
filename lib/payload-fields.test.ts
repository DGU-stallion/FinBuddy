import { describe, it, expect } from 'vitest';
import {
  pickTopFirst,
  readSnapshot,
  readFinancials,
  readAnnouncements,
  num,
  str,
  asRecord,
} from './payload-fields';

/**
 * Seam 17: 网关 payload 字段提取（跨模块共享的形状适配）
 *
 * 公共接口：
 *  - pickTopFirst(payload, key): 顶层优先、回退 data 嵌套
 *  - readSnapshot / readFinancials / readAnnouncements: 三类 payload 的字段视图
 *
 * 抓到：同一份 payload 在两个消费者里取到不同值（形状规则分叉）、
 *       缺字段被 0/'' 冒充、真空期漏判。
 * 漏掉：字段语义是否正确（需对照真机抓取的 payload）。
 *
 * 关键红线：**形状规则必须单一事实来源**（Standard 轴评审 #7）。
 * 缺字段一律 undefined，绝不用默认值冒充 —— 由调用方显式声明"缺失"。
 */

const REAL_FINANCIALS = {
  refId: 'ref_3',
  source: '扶摇 · 利润表/财务指标',
  asOf: 1791856750616,
  isFallback: false,
  baseRevenue: 124518996370.97,
  revenueBasis: 'TTM',
  netMargin: 35.2661,
  grossMargin: 46.2522,
  taxRate: 14.678138806059899,
  data: {
    thscode: '300308.SZ',
    report: '2026-2',
    baseRevenue: 124518996370.97,
    revenueBasis: 'TTM',
    netMargin: 35.2661,
    grossMargin: 46.2522,
    taxRate: 14.678138806059899,
  },
};

const REAL_SNAPSHOT = {
  refId: 'ref_4',
  source: '扶摇 · 行情/估值快照',
  asOf: 1791854469987,
  isFallback: false,
  data: {
    thscode: '300750.SZ',
    name: '宁德时代',
    last_price: 298.38,
    price_change_ratio_pct: 0.211587,
    turnover: 12580165600,
    pe_ttm: 16.243252,
    pb_mrq: 3.639555,
  },
};

describe('asRecord / num / str', () => {
  it('null/基本类型一律返回空对象（不抛异常）', () => {
    for (const v of [null, undefined, 1, 'x', true]) expect(asRecord(v)).toEqual({});
  });

  it('数组按对象处理（JS 语义如此）但取字段自然落空', () => {
    // 记录该行为以免误以为数组会被转成 {}；对取值无影响（数组无这些键）
    expect(asRecord([])).toEqual([]);
    expect(asRecord([{ a: 1 }]).a).toBeUndefined();
  });

  it('num 只接受有限数（NaN/Infinity/字符串 → undefined）', () => {
    expect(num(1.5)).toBe(1.5);
    expect(num(0)).toBe(0); // 0 是合法值，不是缺失
    expect(num(NaN)).toBeUndefined();
    expect(num(Infinity)).toBeUndefined();
    expect(num('1')).toBeUndefined();
  });

  it('str 只接受非空字符串（空白串视为缺失）', () => {
    expect(str('x')).toBe('x');
    expect(str('   ')).toBeUndefined();
    expect(str(1)).toBeUndefined();
  });
});

describe('pickTopFirst', () => {
  it('顶层优先', () => {
    expect(pickTopFirst({ a: 1, data: { a: 2 } }, 'a')).toBe(1);
  });

  it('顶层缺失时回退 data 嵌套', () => {
    expect(pickTopFirst({ data: { a: 2 } }, 'a')).toBe(2);
  });

  it('两处都缺返回 undefined（不默认 0）', () => {
    expect(pickTopFirst({ data: {} }, 'a')).toBeUndefined();
    expect(pickTopFirst(null, 'a')).toBeUndefined();
  });
});

describe('readFinancials（真机 payload）', () => {
  it('取出全部测算参数与口径/报告期', () => {
    const f = readFinancials(REAL_FINANCIALS);
    expect(f.baseRevenue).toBe(124518996370.97);
    expect(f.revenueBasis).toBe('TTM');
    expect(f.netMargin).toBe(35.2661);
    expect(f.grossMargin).toBe(46.2522);
    expect(f.taxRate).toBeCloseTo(14.678, 3);
    expect(f.report).toBe('2026-2');
  });

  it('只有 data 嵌套（无顶层）时也能取到（回退生效）', () => {
    const onlyNested = { data: REAL_FINANCIALS.data };
    const f = readFinancials(onlyNested);
    expect(f.baseRevenue).toBe(124518996370.97);
    expect(f.netMargin).toBe(35.2661);
  });

  it('缺字段返回 undefined（不冒充 0）', () => {
    const f = readFinancials({ data: {} });
    expect(f.baseRevenue).toBeUndefined();
    expect(f.taxRate).toBeUndefined();
  });
});

describe('readSnapshot（真机 payload）', () => {
  it('取出行情与估值字段', () => {
    const s = readSnapshot(REAL_SNAPSHOT);
    expect(s.name).toBe('宁德时代');
    expect(s.thscode).toBe('300750.SZ');
    expect(s.lastPrice).toBe(298.38);
    expect(s.changePct).toBeCloseTo(0.211587, 6);
    expect(s.peTtm).toBeCloseTo(16.243252, 6);
    expect(s.pbMrq).toBeCloseTo(3.639555, 6);
  });

  it('空 payload 不抛异常且全 undefined', () => {
    const s = readSnapshot(null);
    expect(s.lastPrice).toBeUndefined();
    expect(s.name).toBeUndefined();
  });
});

describe('readAnnouncements', () => {
  it('有结果时 vacuum=false 且逐条取出标题/日期', () => {
    const a = readAnnouncements({
      items: [
        { title: '公告A', snippet: '片段', date: '2026-08-01' },
        { title: '公告B', snippet: '片段', date: '2026-07-15' },
      ],
    });
    expect(a.vacuum).toBe(false);
    expect(a.items).toHaveLength(2);
    expect(a.items[0].title).toBe('公告A');
  });

  it('vacuum=true 或 items 为空都判定为真空期', () => {
    expect(readAnnouncements({ vacuum: true, items: [] }).vacuum).toBe(true);
    expect(readAnnouncements({ items: [] }).vacuum).toBe(true);
    expect(readAnnouncements({}).vacuum).toBe(true);
  });

  it('形状异常不抛异常', () => {
    expect(() => readAnnouncements({ items: 'not-array' })).not.toThrow();
    expect(readAnnouncements({ items: 'not-array' }).items).toEqual([]);
  });

  it('确定性：同输入同输出', () => {
    const a = { items: [{ title: 't' }] };
    expect(readAnnouncements(a)).toEqual(readAnnouncements(a));
  });
});
