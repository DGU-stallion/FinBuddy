import { describe, it, expect } from 'vitest';
import {
  reconcileFinancials,
  reconcileSnapshot,
  runLedger,
  describeFindings,
  checkValuationIdentity,
  type Finding,
} from './reconcile';

/**
 * Seam: 对账器 —— 在确定性计算之前判定"输入能不能信"
 *
 * 公共接口：
 *  - reconcileFinancials(input) / reconcileSnapshot(input) -> LedgerEntry
 *  - runLedger(entries, {blockOn}) -> Ledger（含 blocked 判定）
 *  - describeFindings(findings) -> 给模型的拒绝理由文本
 *
 * 抓到：口径错误（累计被求和）、恒等式违背、量纲/量级越界、口径未标注。
 * 漏掉：无法判断"这个数与该公司的真实经营是否相符"（那需要外部基准，
 *      刻意不引入 —— 见模块头注释）。
 *
 * 关键红线：对账器**只报告，不修改数据**；是否拒绝由调用方决定。
 */

const codes = (fs: Finding[]) => fs.map((f) => f.code);

describe('累计口径检测（本模块存在的核心理由）', () => {
  /**
   * 真缺陷回归：宁德时代预置案例基准营收 11,128 亿（公开量级约 3,700 亿）。
   * 根因假设：`period:'quarterly'` 返回的是年内累计（YTD），被 `sumTTM` 直接相加。
   */
  it('年内累计（升序）被判定为 block，且点名"不得相加"', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 8500e8, // = 2775+925+3700+1100，与下方序列自洽
      revenueBasis: 'TTM',
      // 年内累计（真机实测的同构形态：年内递增 + 跨年骤降）
      // 必须是**两年**数据：单年内递增不构成累计特征（真机验证结论）
      revenueSeries: [
        { year: 2026, period: 'Q2', revenue: 2775e8 },
        { year: 2026, period: 'Q1', revenue: 925e8 },
        { year: 2025, period: 'Q4', revenue: 3700e8 },
        { year: 2025, period: 'Q1', revenue: 1100e8 },
      ],
    });
    expect(codes(e.findings)).toContain('cumulative_caliber_suspected');
    const f = e.findings.find((x) => x.code === 'cumulative_caliber_suspected')!;
    expect(f.severity).toBe('block');
    // 量纲提升到"亿元"并带具体数字（无数字的告警无法复盘）
    expect(f.detail).toContain('8500 亿元');
    expect(f.detail).toContain('累计值不得相加');
  });

  /**
   * 这条用例是**防回归的关键**：上游按时间倒序返回（Q4→Q1）时，
   * 累计序列是递减的。早期实现用"严格递增"判定，会恰好漏掉真实场景 ——
   * 无法证伪的检测器等于没有检测器。
   */
  it('年内累计（倒序返回，即真实上游顺序）同样被判定为 block', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 8500e8,
      revenueSeries: [
        { year: 2026, period: 'Q2', revenue: 2775e8 },
        { year: 2026, period: 'Q1', revenue: 925e8 },
        { year: 2025, period: 'Q4', revenue: 3700e8 },
        { year: 2025, period: 'Q1', revenue: 1100e8 },
      ],
    });
    expect(codes(e.findings)).toContain('cumulative_caliber_suspected');
  });

  /**
   * 真机 fixture 的实测形态（2026-10-13 抓取）。
   *
   * ⚠️ 更正：本用例原先写成“真实单季数据不触发”，是**我把语义标错了** ——
   * 这组数字的真机语义**就是年内累计**（对账器与真机自测都确认了：
   * 2026Q1=195 → Q2=418 递增、年界 195/382=0.51 骤降）。
   * 所以正确断言是“**应当**触发”。写成 not.toContain 会锁死一个假阴性。
   */
  it('真机 fixture 形态（年内递增 + 年界骤降）判定为 block', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 124518996370.97,
      revenueBasis: 'TTM',
      revenueSeries: [
        { year: 2026, period: 'Q2', revenue: 417.78e8 },
        { year: 2026, period: 'Q1', revenue: 194.96e8 },
        { year: 2025, period: 'Q4', revenue: 382.4e8 },
        { year: 2025, period: 'Q3', revenue: 250.05e8 },
      ],
    });
    const f = e.findings.find((x) => x.code === 'cumulative_caliber_suspected');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('block');
  });

  /**
   * 如实记录检测力的**上界**（不能假装它是完美判别器）。
   *
   * “年内递增 + 年界骤降”在数学上并非累计独有：真实单季数据只要
   * 每年 Q1→Q2 都在增长、且新一年首季低于上年末季，同样会命中。
   *
   * 为什么仍然接受这个假阳性：代价不对称 ——
   * 误报的代价是“要人工确认一次口径”，漏报的代价是
   * “一个错 2.6~3 倍的营收被当成财报事实展示给投资者”。
   * 故宁可拦下并要求确认。
   */
  it('局限：无法区分“累计”与“逐年递增的单季数据”（已知假阳性，仍选择拦截）', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 1000e8,
      revenueBasis: 'TTM',
      // 若这是真实单季：每年 Q1<Q2、且 2026Q1 < 2025Q4 —— 与累计同形
      revenueSeries: [
        { year: 2026, period: 'Q2', revenue: 260e8 },
        { year: 2026, period: 'Q1', revenue: 130e8 },
        { year: 2025, period: 'Q4', revenue: 250e8 },
        { year: 2025, period: 'Q1', revenue: 120e8 },
      ],
    });
    // 断言它**确实**会误报 —— 把已知局限锁进测试，避免后人误以为覆盖完备
    expect(codes(e.findings)).toContain('cumulative_caliber_suspected');
  });

  it('单季数据有正常季节性波动时不触发（不把波动误判成累计）', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 1140e8,
      revenueSeries: [
        { year: 2026, period: 'Q2', revenue: 260e8 },
        { year: 2026, period: 'Q1', revenue: 300e8 },
        { year: 2025, period: 'Q4', revenue: 180e8 },
        { year: 2025, period: 'Q1', revenue: 400e8 },
      ],
    });
    expect(codes(e.findings)).not.toContain('cumulative_caliber_suspected');
  });

  it('期数不足 3 期时不做判定（样本太少，判定无依据）', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 1850e8,
      revenueSeries: [
        { year: 2025, period: 'Q1', revenue: 925e8 },
        { year: 2025, period: 'Q2', revenue: 1850e8 },
      ],
    });
    expect(codes(e.findings)).not.toContain('cumulative_caliber_suspected');
  });

  it('未提供 revenueSeries 时不判定（装配层还没暴露逐期数据）', () => {
    const e = reconcileFinancials({ refId: 'ref_1', baseRevenue: 11282e8, revenueBasis: 'TTM' });
    expect(codes(e.findings)).not.toContain('cumulative_caliber_suspected');
  });
});

describe('利润表内部一致性', () => {
  it('净利率高于毛利率 → block（净利不可能超过毛利）', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 1000e8,
      grossMargin: 20,
      netMargin: 35,
    });
    expect(codes(e.findings)).toContain('margin_order_inverted');
    expect(e.findings.find((f) => f.code === 'margin_order_inverted')!.severity).toBe('block');
  });

  it('净利率与（净利润÷营收）量级背离 → warn', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 11128e8, // 被人为放大 3 倍的营收
      netMargin: 16.98, // 单季口径指标
      netProfitTTM: 507e8, // 真实 TTM 净利润
    });
    expect(codes(e.findings)).toContain('margin_recipe_mismatch');
  });

  it('口径一致时两条检查都不触发', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 3700e8,
      netMargin: 13.7,
      netProfitTTM: 507e8, // 507/3700 = 13.7%
      grossMargin: 24,
    });
    expect(codes(e.findings)).not.toContain('margin_recipe_mismatch');
    expect(codes(e.findings)).not.toContain('margin_order_inverted');
  });
});

describe('量纲与量级', () => {
  it('有效税率超出合理区间 → warn', () => {
    const e = reconcileFinancials({ refId: 'ref_1', baseRevenue: 100e8, taxRate: 62 });
    expect(codes(e.findings)).toContain('tax_rate_out_of_range');
  });

  it('正常税率区间内不触发', () => {
    const e = reconcileFinancials({ refId: 'ref_1', baseRevenue: 100e8, taxRate: 14.84 });
    expect(codes(e.findings)).not.toContain('tax_rate_out_of_range');
  });

  it('营收量级越界 → 分档报告（5 万亿 warn，20 万亿 block）', () => {
    const warn = reconcileFinancials({ refId: 'ref_1', baseRevenue: 6e12 });
    expect(warn.findings.find((f) => f.code === 'revenue_scale_implausible')!.severity).toBe('warn');

    const block = reconcileFinancials({ refId: 'ref_1', baseRevenue: 3e13 });
    expect(block.findings.find((f) => f.code === 'revenue_scale_implausible')!.severity).toBe(
      'block',
    );
  });

  /**
   * 如实记录检测力的边界：11,128 亿**不会**被量级检查抓到（1.1 万亿 < 5 万亿）。
   * 所以抓它只能靠累计口径检测 —— 这条断言防止后人误以为量级检查兜得住。
   */
  it('11,128 亿（宁德实际错误值）不触发量级检查，只能靠累计检测', () => {
    const e = reconcileFinancials({ refId: 'ref_1', baseRevenue: 1112821442000 });
    expect(codes(e.findings)).not.toContain('revenue_scale_implausible');
  });

  it('给出基准营收却不标注口径 → warn', () => {
    const e = reconcileFinancials({ refId: 'ref_1', baseRevenue: 1000e8 });
    expect(codes(e.findings)).toContain('unlabeled_caliber');

    const labeled = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 1000e8,
      revenueBasis: 'TTM',
    });
    expect(codes(labeled.findings)).not.toContain('unlabeled_caliber');
  });
});

describe('估值恒等式（不依赖任何外部基准数据）', () => {
  it('PB÷PE 推出的 ROE 异常高 → warn，且明确是告警而非证伪', () => {
    // 中际旭创 fallback 真值：PB 21.41 / PE 41.72 = 51.3%
    const fs = checkValuationIdentity({ peTTM: 41.722396, pbMRQ: 21.409387 });
    expect(fs.length).toBe(1);
    expect(fs[0].code).toBe('roe_identity_implausible');
    expect(fs[0].severity).toBe('warn');
    expect(fs[0].detail).toContain('51.31%');
    // 诚实声明检测力边界 —— 不得读成"该数据是错的"
    expect(fs[0].detail).toContain('告警而非证伪');
  });

  it('宁德时代 fallback 真值（PB 3.64 / PE 16.24 = 22.4%）不触发', () => {
    expect(checkValuationIdentity({ peTTM: 16.243252, pbMRQ: 3.639555 })).toEqual([]);
  });

  it('缺任一字段时不判定', () => {
    expect(checkValuationIdentity({ peTTM: 41.7 })).toEqual([]);
    expect(checkValuationIdentity({ pbMRQ: 21.4 })).toEqual([]);
    expect(checkValuationIdentity({})).toEqual([]);
  });

  it('负 PE（亏损）时跳过 —— 负 ROE 无解释力', () => {
    expect(checkValuationIdentity({ peTTM: -12, pbMRQ: 3 })).toEqual([]);
  });
});

describe('行情快照对账', () => {
  it('最新价非正 → block', () => {
    const e = reconcileSnapshot({ refId: 'ref_1', lastPrice: 0 });
    expect(e.findings.find((f) => f.code === 'nonpositive_price')!.severity).toBe('block');
  });

  it('快照层同样带估值恒等式检查', () => {
    const e = reconcileSnapshot({ refId: 'ref_1', lastPrice: 724.47, peTTM: 41.72, pbMRQ: 21.41 });
    expect(codes(e.findings)).toContain('roe_identity_implausible');
  });
});

describe('账本汇总与拒绝阈值', () => {
  const blockEntry = reconcileFinancials({
    refId: 'ref_1',
    baseRevenue: 9250e8,
    grossMargin: 10,
    netMargin: 35,
  });
  const warnEntry = reconcileFinancials({ refId: 'ref_2', baseRevenue: 100e8 });

  it('默认阈值 block：warn 不触发拒绝', () => {
    const led = runLedger([warnEntry]);
    expect(led.blocked).toBe(false);
    expect(led.ok).toBe(false); // 有 warn，所以不算"干净"
  });

  it('block 级结论触发 blocked', () => {
    const led = runLedger([blockEntry]);
    expect(led.blocked).toBe(true);
  });

  it('blockOn:"warn" 时 warn 也拒绝（严格模式）', () => {
    const led = runLedger([warnEntry], { blockOn: 'warn' });
    expect(led.blocked).toBe(true);
  });

  it('全部通过时 ok=true 且无结论', () => {
    const clean = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 3700e8,
      revenueBasis: 'TTM',
      netMargin: 13.7,
      netProfitTTM: 507e8,
      grossMargin: 24,
      taxRate: 14.84,
    });
    const led = runLedger([clean]);
    expect(led.findings).toEqual([]);
    expect(led.ok).toBe(true);
    expect(led.blocked).toBe(false);
  });

  it('entries 按 refId 保留分组（前端据此定位到具体存证）', () => {
    const led = runLedger([blockEntry, warnEntry]);
    expect(led.entries.map((e) => e.refId)).toEqual(['ref_1', 'ref_2']);
    expect(led.findings.length).toBe(blockEntry.findings.length + warnEntry.findings.length);
  });
});

describe('describeFindings —— 拒绝必须说明原因', () => {
  it('渲染出严重度与具体数字（模型据此归入「无法验证项」）', () => {
    const e = reconcileFinancials({
      refId: 'ref_1',
      baseRevenue: 9250e8,
      // 年内累计（真机实测的同构形态：年内递增 + 跨年骤降）
      // 必须是**两年**数据：单年内递增不构成累计特征（真机验证结论）
      revenueSeries: [
        { year: 2026, period: 'Q2', revenue: 2775e8 },
        { year: 2026, period: 'Q1', revenue: 925e8 },
        { year: 2025, period: 'Q4', revenue: 3700e8 },
        { year: 2025, period: 'Q1', revenue: 1100e8 },
      ],
    });
    const text = describeFindings(e.findings);
    expect(text).toContain('[block]');
    expect(text).toContain('8500 亿元');
  });

  it('info 级不输出（只把需要行动的部分告诉模型）', () => {
    expect(describeFindings([{ code: 'x', severity: 'info', claim: 'c', detail: 'd' }])).toBe('');
  });

  it('无结论时返回空串', () => {
    expect(describeFindings([])).toBe('');
  });
});
