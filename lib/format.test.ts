import { describe, it, expect } from 'vitest';
import { formatSnapshotForLLM, formatFinancialsForLLM, toYi, utcDate } from './format';

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

describe('formatFinancialsForLLM · 税率来源必须与 UI 口径一致（Standard 轴评审 #2）', () => {
  const base = {
    refId: 'ref_1',
    source: '扶摇 · 利润表/财务指标',
    asOf: Date.UTC(2026, 9, 13),
    isFallback: false,
    data: {
      report: '2026-2',
      baseRevenue: 124518996370.97,
      revenueBasis: 'TTM' as const,
      netMargin: 35.2661,
      grossMargin: 46.2522,
      taxRate: 14.678138806059899,
    },
  };

  it('标注"有效所得税率（推导）"，不得让模型以为是接口直出字段', () => {
    const t = formatFinancialsForLLM(base);
    // 关键：这是喂给模型的上下文，决定模型在正文里怎么转述。
    // 若此处无标注，模型会说"据财报，所得税率为 14.84%" —— 绕过 UI 的诚实标注。
    expect(t).toContain('有效所得税率');
    expect(t).toMatch(/推导/);
    expect(t).toMatch(/Σ|税前利润/);
  });

  it('与存证抽屉 / 测算卡片的口径一致（三处措辞必须同源）', () => {
    const t = formatFinancialsForLLM(base);
    expect(t).toContain('所得税费用');
  });

  it('税率缺失时写"缺失"，不回退默认值', () => {
    const t = formatFinancialsForLLM({ ...base, data: { ...base.data, taxRate: undefined } });
    expect(t).toContain('缺失');
    expect(t).not.toMatch(/所得税率：15/);
  });

  it('降级财务数据带 fallbackNote（与 Snapshot 对称）', () => {
    const t = formatFinancialsForLLM({
      ...base,
      isFallback: true,
      fallbackNote: '财务参数抓取于 2026-10-13，非最新报告期',
    });
    expect(t).toContain('降级存证');
    expect(t).toContain('非最新报告期');
  });
});

describe('共享格式化助手（消除多处重复实现）', () => {
  it('toYi 与原有各处口径一致（两位小数 + 亿元）', () => {
    expect(toYi(124518996370.97)).toBe('1245.19 亿元');
    expect(toYi(0)).toBe('0.00 亿元');
    expect(toYi(1e8)).toBe('1.00 亿元');
  });

  it('utcDate 输出 UTC 纯日期，且缺失时给"时点缺失"而非 Invalid Date', () => {
    expect(utcDate(Date.UTC(2026, 9, 13, 23, 59))).toBe('2026-10-13');
    // 跨时区稳定：UTC 23:59 仍属当日（本地时区若为 +8 会变成次日）
    expect(utcDate(0)).toBe('时点缺失');
    expect(utcDate(undefined)).toBe('时点缺失');
    expect(utcDate(NaN)).toBe('时点缺失');
  });
});
