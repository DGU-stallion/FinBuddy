import { describe, it, expect } from 'vitest';
import { formatSnapshotForLLM, formatFinancialsForLLM } from './format';

/**
 * Seam 11: payload -> LLM 上下文文本
 * 公共接口：把网关返回的结构化 JSON 转成带来源/时点/单位标注的 LLM 可读文本。
 * 抓到：字段映射、单位换算、时点标注、缺失字段的显式声明。
 * 漏掉：LLM 如何使用这段文本（模型行为，不可测）。
 *
 * 关键红线（ADR-0001 / ADR-0002）：时点与来源必须出现在文本里，
 * 让模型无法"忘记"标注出处；缺字段必须显式写"缺失"，不得静默省略。
 */

describe('formatSnapshotForLLM', () => {
  it('映射真实扶摇字段并保留单位与来源时点', () => {
    const text = formatSnapshotForLLM({
      refId: 'ref_1',
      source: '扶摇 · get_a_share_prices_snapshot',
      asOf: 1791817338000,
      isFallback: false,
      data: {
        thscode: '300308.SZ',
        name: '中际旭创',
        last_price: 724.47,
        price_change_ratio_pct: -6.411316,
        turnover: 15623739000,
        pe_ttm: 41.722396,
        pb_mrq: 21.409387,
      },
    });

    expect(text).toContain('300308.SZ');
    expect(text).toContain('中际旭创');
    expect(text).toContain('724.47');
    expect(text).toContain('-6.41%');
    expect(text).toContain('PE(TTM)');
    expect(text).toContain('41.72');
    // 来源与时点必须出现，模型无法"忘记"引用
    expect(text).toContain('扶摇');
    expect(text).toContain('ref_1');
  });

  it('降级数据必须带显著过期警告', () => {
    const text = formatSnapshotForLLM({
      refId: 'ref_9',
      source: 'L2 本地存证',
      asOf: 1704067200000,
      isFallback: true,
      fallbackNote: '抓取于 2024-01-01',
      data: { thscode: '300308.SZ', name: '中际旭创', last_price: 100 },
    });

    expect(text).toContain('降级');
    expect(text).toContain('2024-01-01');
  });

  it('缺失字段显式声明，不静默省略', () => {
    const text = formatSnapshotForLLM({
      refId: 'ref_2',
      source: '扶摇',
      asOf: 1,
      isFallback: false,
      data: { thscode: '300308.SZ', name: '中际旭创' },
    });

    expect(text).toContain('缺失');
  });
});

describe('formatFinancialsForLLM', () => {
  it('把净利率与营收换算为百分号与亿元，并标注年限口径', () => {
    const text = formatFinancialsForLLM({
      refId: 'ref_3',
      source: '扶摇 · get_a_share_financials_indicators',
      asOf: 1791817357000,
      isFallback: false,
      data: {
        thscode: '300308.SZ',
        report: '2024-3',
        baseRevenue: 16300000000,
        revenueBasis: 'TTM',
        netMargin: 22.3627,
        grossMargin: 33.3214,
        taxRate: 15,
      },
    });

    expect(text).toContain('163.00 亿元');
    expect(text).toContain('22.36%');
    expect(text).toContain('33.32%');
    expect(text).toContain('TTM');
    expect(text).toContain('ref_3');
  });
});
