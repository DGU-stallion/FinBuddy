/**
 * 对账器（reconciler）—— 在确定性计算之前，先判定"输入到底能不能信"
 *
 * ## 为什么需要它（这个模块的存在理由）
 *
 * 真缺陷：宁德时代预置案例的基准营收是 **11,128 亿**（公开量级 3,600–4,000 亿，
 * 偏高约 3 倍），中际旭创同理偏高数倍。根因是 `gateway.ts` 用 `period:'quarterly'`
 * 取了多期利润表后**直接拼接**，而 A 股惯例下的 `quarterly` 常为**年内累计（YTD）**：
 * 四期 Q1/Q2/Q3/Q4 = 925/1850/2775/3700，求和 = 9250 亿（≈2.5 年营收）。
 *
 * 关键教训不是"公式写错了"，而是：
 * **"确定性"不等于"正确性"。** 一个纯函数公式可以毫无误差地
 * 把一个错 3 倍的输入，放大成一张看起来非常可信的图。
 *
 * 当时所有防线都拦不住它：
 * - `sumTTM` 的单测用**合成数据**验证加法 → 加法确实没错
 * - `sensitivity.test.ts` 的"量级检查"只是断言 `1245×10%×35%×85%≈37` → 纯乘法
 * - `output-contract.ts` 只查三栏/真空期是否存在 → **完全不看数字**
 * - `computeSensitivity` 只查 `Number.isFinite` → 11,128 亿是完全合法的有限数
 *
 * ## 设计原则：不依赖任何外部基线
 *
 * 对账器**不**去查"宁德时代真实营收是多少"（那需要引入一份会过期的基准数据，
 * 且等于把判断权交给硬编码）。它只做**内部自洽性**判定：
 * 恒等式、口径形态、序列形状、量纲与量级边界。这样它在离线、断网、
 * 任意新标的上都同样有效 —— 这是"通用工具"而非"针对某只股票的特判"。
 *
 * ## 与其他护栏的分工
 *
 * | 模块 | 判定什么 | 层次 |
 * |---|---|---|
 * | `citations.ts` | 引用号是否真实存在 | 引用存在性 |
 * | `output-contract.ts` | 正文结构/合规语言/真空期声明 | 成稿形态 |
 * | **本模块** | **数值本身是否可信** | **证据自洽性** |
 * | `sensitivity.ts` | 用给定输入算冲击 | 确定性计算 |
 *
 * 顺序是刻意的：**先对账，再计算**。算出精确数字之前，
 * 要先知道输入值不值得算。
 *
 * 纯函数、零框架依赖（与 lib/ 其余模块一致），可在 node 环境直接测试。
 */

// ---------- 类型 ----------

export type Severity = 'block' | 'warn' | 'info';

/**
 * 一条对账结论。
 *
 * `code` 是稳定的机器可读标识（前端/测试不得靠嗅探 `detail` 文案 ——
 * 改文案会静默失效，这是本仓库已被抓到过的坑）。
 */
export interface Finding {
  code: string;
  severity: Severity;
  /** 被判定的是哪一条断言（人类可读）。 */
  claim: string;
  /** 为什么不过 —— 必须带具体数字，否则无法复盘。 */
  detail: string;
}

export interface LedgerEntry {
  refId: string;
  kind: 'financials' | 'snapshot';
  findings: Finding[];
}

export interface Ledger {
  /** 无 block 且无 warn。 */
  ok: boolean;
  /** 存在 block 级结论 —— 调用方**必须**拒绝使用这批数据。 */
  blocked: boolean;
  entries: LedgerEntry[];
  /** 摊平后的全部结论（便于前端一次性渲染）。 */
  findings: Finding[];
}

/**
 * 逐期营收（带财年/季度标签）。
 *
 * 标签**不是可选的装饰**：累计口径只能从"年内递增 + 年界骤降"这个结构识别。
 * 真机实测证明确实如此 —— 只看数值大小的启发式（等差/跨度）会在
 * 真实数据上直接漏报（宁德时代 2769/1291/4237/2830 的差分比高达 24 倍）。
 * 因此上游必须把 `fiscal_year` / `fiscal_period` 原样带下来。
 */
export interface RevenuePeriod {
  year?: number;
  /** 季度标签，支持 `Q2` / `2` / `2026-2` 等形式。 */
  period?: string;
  revenue: number;
}

/** 财务参数输入（结构兼容 `gateway.FinancialsResult` 与 L2 兜底记录）。 */
export interface FinancialsInput {
  refId: string;
  baseRevenue?: number;
  revenueBasis?: string;
  netMargin?: number;
  grossMargin?: number;
  taxRate?: number;
  /**
   * TTM 净利润。与 `baseRevenue` 同期同口径时应满足
   * `netProfitTTM / baseRevenue ≈ netMargin`。
   */
  netProfitTTM?: number;
  /** 逐期营收原始序列（对账的载荷所在）。 */
  revenueSeries?: RevenuePeriod[];
}

export interface SnapshotInput {
  refId: string;
  lastPrice?: number;
  peTTM?: number;
  pbMRQ?: number;
  turnover?: number;
}

// ---------- 阈值（集中一处，便于解释与调整） ----------

/**
 * 净利率与（净利润/营收）的相对容差。
 *
 * 放宽到 35% 是刻意的：TTM 营收与"最近一期"净利率本就可能不同口径，
 * 小幅不一致是正常的。此检查只抓**数量级**背离（如 16.98% vs 4.5%），
 * 不做精密对账 —— 宁可漏报小幅偏差，也不要天天误报把闸门逼成噪音。
 */
const MARGIN_RECIPE_TOLERANCE = 0.35;

/**
 * ROE 合理性上界（%）。
 *
 * 诚实声明其检测力：这是"**异常高，需人工确认**"的告警，**不是**"不可能"的证明。
 * PB÷PE = ROE 是恒等式，导致它只能抓到**数量级**错误（如万元/元混用、
 * PE 与 PB 取自不同期），抓不住中等幅度膨胀 ——
 * 例如中际旭创 fallback 真值推出 ROE 51.3%，高但不无可能，仍会触发告警。
 *
 * 为什么阈值仍定在 50 而非更宽松：这是 `warn` 而非 `block`，
 * 误报的代价只是模型多写一句"该项异常，需确认"，
 * 而漏报的代价是一个错数字被当成财报事实 —— 代价不对称，宁可多报。
 */
const ROE_UPPER_PCT = 50;
/** ROE 下界（%）。负 ROE 意味着亏损，与"PE 为正"矛盾。 */
const ROE_LOWER_PCT = -5;

/** 单期营收量级上界（元）。超过 5 万亿的 A 股单体营收极罕见。 */
const REVENUE_WARN_YUAN = 5e12;
const REVENUE_BLOCK_YUAN = 2e13;

/** 有效税率合理区间（%）。 */
const TAX_MIN_PCT = 0;
const TAX_MAX_PCT = 40;

/**
 * 累计口径检测：相邻差分是否近似相等（等差数列）的容忍倍率。
 *
 * 仅用于**无标签**时的弱判定（降级为 warn）。有标签时走下面更强的判据。
 * 真机实测证明该判据很弱 —— 宁德时代真实累计序列
 *（2769/1291/4237/2830）的差分比高达 24 倍，并不呈等差，
 * 因此这个启发式会**漏报**（假阴性）。保留它只作为无标签时的兼底。
 */
const ARITHMETIC_DIFF_TOLERANCE = 1.9;

/** 无标签兼底：序列首尾跨度（最大值 ÷ 最小值）下界。 */
const CUMULATIVE_MIN_SPAN = 2.5;

/**
 * 年界骤降判据：某年最小季度值 ÷ 上一年最大季度值时 < 该比值 ⇒ 判为跨年回落。
 *
 * 真机验证：宁德时代 1291/4237 = 0.30。单季真实营收不会如此 ——
 * 即使成长很快，上一年末季也不会是新一年首季的 1.3 倍以上。
 * 这一条是区分"真累计"与"高速成长公司的单季自然增长"的关键。
 */
const BOUNDARY_DROP_RATIO = 0.75;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function pct(v: number): string {
  return `${v.toFixed(2)}%`;
}

function yi(v: number): string {
  return `${(v / 1e8).toFixed(0)} 亿元`;
}

// ---------- 单项检查 ----------

/**
 * 口径形态：逐期营收是否呈现**年内累计（YTD）**特征。
 *
 * 两条判据，优先用带标签的强判据：
 *
 * **强（有 year/period 标签）**：按财年分组后，年内序列严格递增，
 * 且**存在年界骤降**（某年首季 ≤ 上年末季 × 0.75）。
 * 真机验证：宁德时代 [2769.2, 1291.3, 4237.0, 2830.7] 按年分组后
 * 2026: 1291→2769 递增、2025: 2831→4237 递增，且 1291/4237 = 0.30 骤降 → 命中。
 *
 * **弱（无标签兼底）**：跨度 ≥ 2.5 倍且差分近似等差 → 仅报 warn。
 *
 * ## 为什么必须用标签（这是本次最重要的发现）
 *
 * 第一版刻意只看数值大小（"排序后等差"），写完后**真机自测给出了假阴性**：
 * 真实累计序列 2769/1291/4237/2830 的差分比高达 24 倍，完全不呈等差。
 * 根本原因：累计是**按年分组内递增**，跨年边界骤降，把两组数据拍平后
 * 等差特征就消失了。丢掉 `fiscal_year` 就等于把唯一可靠的结构信息丢掉。
 *
 * ## 为什么“年界骤降”是关键判据
 *
 * 它能区分真累计与"高速成长公司的单季自然增长"。两者年内都递增，
 * 但只有累计会在年界处从全年值回落到一季度值。
 *（例：若某公司 2025Q4 单季 300、2026Q1 单季 400，即使增长很快也不骤降）
 *
 * 局限（如实声明）：
 * - 缺标签时只能给 warn，**不具备拦截力** —— 不会出错，但会漏报。
 * - 数据恰好“年内递增 + 年界骤降”但不是累计（极罕见）时会误报，
 *   人工确认 `fiscal_period` 语义即可。误报代价是一次确认，
 *   漏报代价是错误数字被当成财报事实展示（后者严重得多）。
 */
function checkCumulativePattern(input: FinancialsInput): Finding[] {
  const series = (input.revenueSeries ?? []).filter((s) => finite(s.revenue));
  if (series.length < 3) return [];

  const parsed = series.map((s) => ({ ...s, q: quarterOf(s) }));
  const labeled = parsed.filter((s) => s.year !== undefined && s.q !== undefined);

  // ---- 强判据：按财年分组 ----
  if (labeled.length >= 3) {
    const byYear = new Map<number, Array<{ q: number; revenue: number }>>();
    for (const s of labeled) {
      const list = byYear.get(s.year as number) ?? [];
      list.push({ q: s.q as number, revenue: s.revenue });
      byYear.set(s.year as number, list);
    }
    const years = [...byYear.keys()].sort((a, b) => b - a); // 新 → 旧

    let withinYearIncreasing = true;
    for (const y of years) {
      const rows = byYear.get(y)!.slice().sort((a, b) => a.q - b.q);
      for (let i = 1; i < rows.length; i++) {
        if (!(rows[i].revenue > rows[i - 1].revenue)) withinYearIncreasing = false;
      }
    }

    // 年界骤降：某年最小季度值 / 上一年最大季度值
    let boundaryDrop = false;
    let worst = 1;
    for (let i = 0; i < years.length - 1; i++) {
      const newer = byYear.get(years[i])!.map((r) => r.revenue);
      const older = byYear.get(years[i + 1])!.map((r) => r.revenue);
      const ratio = Math.min(...newer) / Math.max(...older);
      if (ratio < BOUNDARY_DROP_RATIO) {
        boundaryDrop = true;
        worst = Math.min(worst, ratio);
      }
    }

    if (withinYearIncreasing && boundaryDrop) {
      const vals = parsed.map((s) => s.revenue);
      const sum = vals.reduce((a, b) => a + b, 0);
      const max = Math.max(...vals);
      return [
        {
          code: 'cumulative_caliber_suspected',
          severity: 'block',
          claim: '基准营收是"最近 n 期之和"',
          detail:
            `逐期营收（按财年分组）呈现年内递增、跨年骤降（年界比值低至 ${worst.toFixed(2)}），` +
            `符合**年内累计（YTD）**特征：${vals.map((v) => yi(v)).join(', ')}。` +
            `累计值不得相加 —— ${vals.length} 期之和 ${yi(sum)} 约为单年营收的 ${(sum / max).toFixed(1)} 倍。` +
            `请改用单季口径，或直接取最近一期累计值作为年化基准。`,
        },
      ];
    }
    return [];
  }

  // ---- 弱判据：无标签时的兼底（只报 warn，不具备拦截力） ----
  const vals = parsed.map((s) => s.revenue).sort((a, b) => a - b);
  const min = vals[0];
  const max = vals[vals.length - 1];
  if (min <= 0) return [];
  const span = max / min;
  if (span < CUMULATIVE_MIN_SPAN) return [];

  const diffs = vals.slice(1).map((v, i) => v - vals[i]);
  const dMin = Math.min(...diffs);
  const dMax = Math.max(...diffs);
  if (dMin <= 0 || dMax / dMin > ARITHMETIC_DIFF_TOLERANCE) return [];

  return [
    {
      code: 'cumulative_caliber_suspected',
      severity: 'warn',
      claim: '基准营收可能由累计值相加而得',
      detail:
        `逐期营收缺财年/季度标签，但排序后跨度 ${span.toFixed(2)} 倍且差分近似相等 —— ` +
        `无法排除年内累计。请上游补齐\`fiscal_year\`/\`fiscal_period\` 后重判：` +
        `缺少标签时本检测**不具备拦截力**。`,
    },
  ];
}

/** 从 period 标签抽出季度序号 1..4；无法识别时返回 undefined。 */
function quarterOf(s: RevenuePeriod): number | undefined {
  const p = s.period?.trim();
  if (!p) return undefined;
  const m = /(?:Q|q)?(\d)(?!\d)/.exec(p.replace(/^.*[-—/]/, ''));
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= 4 ? n : undefined;
}

/** 口径标注：算了基准营收却没说是什么口径 —— 口径切换不得静默。 */
function checkBasisLabeled(input: FinancialsInput): Finding[] {
  // 没给出有效营收时无从谈口径（0 与负数都不是"一个基准营收"）
  if (!finite(input.baseRevenue) || input.baseRevenue <= 0) return [];
  const basis = input.revenueBasis?.trim();
  if (basis && basis !== 'missing') return [];
  return [
    {
      code: 'unlabeled_caliber',
      severity: 'warn',
      claim: '基准营收已给出且标注了口径',
      detail: `给出了基准营收 ${yi(input.baseRevenue as number)}，但未标注口径（TTM / 单季×4 / 累计），无法判断它代表多长时间。`,
    },
  ];
}

/** 利润表内部一致性：净利率应约等于 净利润 / 营收。 */
function checkMarginRecipe(input: FinancialsInput): Finding[] {
  const { baseRevenue, netMargin, netProfitTTM } = input;
  if (!finite(baseRevenue) || baseRevenue === 0) return [];
  if (!finite(netMargin) || !finite(netProfitTTM)) return [];

  const implied = (netProfitTTM / baseRevenue) * 100;
  const rel = Math.abs(implied - netMargin) / Math.max(Math.abs(netMargin), 1e-9);
  if (rel <= MARGIN_RECIPE_TOLERANCE) return [];

  return [
    {
      code: 'margin_recipe_mismatch',
      severity: 'warn',
      claim: '净利率与（TTM 净利润 ÷ 基准营收）一致',
      detail:
        `标注净利率 ${pct(netMargin)}，但由 ${yi(netProfitTTM)} ÷ ${yi(baseRevenue)} 反推为 ${pct(implied)}，` +
        `相对偏差 ${(rel * 100).toFixed(0)}%。两者口径不同（如一个取单季、一个取四季之和），` +
        `或其中一方的期数不对。`,
    },
  ];
}

/** 毛利率不得低于净利率（净利 ⊂ 毛利，物理上不可能倒挂）。 */
function checkMarginOrder(input: FinancialsInput): Finding[] {
  const { grossMargin, netMargin } = input;
  if (!finite(grossMargin) || !finite(netMargin)) return [];
  if (netMargin <= grossMargin) return [];
  return [
    {
      code: 'margin_order_inverted',
      severity: 'block',
      claim: '毛利率 ≥ 净利率',
      detail: `净利率 ${pct(netMargin)} > 毛利率 ${pct(grossMargin)}。净利润是毛利润扣掉费用税金后的余额，不可能超过毛利 —— 至少一个字段取错（常见：净利率取到了毛利率字段，或单位不一致）。`,
    },
  ];
}

/** 有效税率合理区间。 */
function checkTaxRate(input: FinancialsInput): Finding[] {
  if (!finite(input.taxRate)) return [];
  const t = input.taxRate;
  if (t >= TAX_MIN_PCT && t <= TAX_MAX_PCT) return [];
  return [
    {
      code: 'tax_rate_out_of_range',
      severity: 'warn',
      claim: `有效所得税率落在 ${TAX_MIN_PCT}%~${TAX_MAX_PCT}%`,
      detail: `推导所得有效税率 ${pct(t)} 超出合理区间（推导式 Σ所得税费用 ÷ Σ税前利润；亏损期不参与合并）。`,
    },
  ];
}

/** 营收量级边界（弱检查，仅兜底极端的单位错误）。 */
function checkRevenueScale(input: FinancialInputOnly): Finding[] {
  if (!finite(input.baseRevenue)) return [];
  const v = input.baseRevenue;
  if (v <= REVENUE_WARN_YUAN) return [];
  const severity: Severity = v > REVENUE_BLOCK_YUAN ? 'block' : 'warn';
  return [
    {
      code: 'revenue_scale_implausible',
      severity,
      claim: '基准营收量级合理',
      detail: `基准营收 ${yi(v)} 超过 ${yi(REVENUE_WARN_YUAN)}，A 股单体公司极少达到该量级；优先怀疑单位（万元/元）或期数口径错误。`,
    },
  ];
}

type FinancialInputOnly = Pick<FinancialsInput, 'baseRevenue'>;

/** 估值恒等式：PB ÷ PE ≈ ROE。不依赖任何外部基准数据。 */
export function checkValuationIdentity(input: {
  peTTM?: number;
  pbMRQ?: number;
}): Finding[] {
  const { peTTM, pbMRQ } = input;
  if (!finite(peTTM) || !finite(pbMRQ)) return [];
  if (peTTM === 0) return [];

  // 负 PE（亏损）时 ROE 无解释力，跳过
  if (peTTM < 0) return [];

  const roe = (pbMRQ / peTTM) * 100;
  if (roe <= ROE_UPPER_PCT && roe >= ROE_LOWER_PCT) return [];

  return [
    {
      code: 'roe_identity_implausible',
      severity: 'warn',
      claim: 'PB ÷ PE 推出的 ROE 落在合理区间',
      detail:
        `PE(TTM) ${peTTM.toFixed(2)} 与 PB(MRQ) ${pbMRQ.toFixed(2)} 反推 ROE = ${pct(roe)}，` +
        `高于 ${ROE_UPPER_PCT}%。恒等式 PB÷PE = ROE 说明二者至少有一个口径不对` +
        `（如 PE 用 TTM 盈利、PB 用最新一期净资产），或该指标异常高需人工确认。` +
        `**这是告警而非证伪**：高景气行业的真实 ROE 可能确实处在该区间。`,
    },
  ];
}

// ---------- 对外入口 ----------

/** 对账一批财务参数。返回结论，**不修改输入**。 */
export function reconcileFinancials(input: FinancialsInput): LedgerEntry {
  const findings: Finding[] = [
    ...checkCumulativePattern(input),
    ...checkMarginOrder(input),
    ...checkMarginRecipe(input),
    ...checkTaxRate(input),
    ...checkRevenueScale(input),
    ...checkBasisLabeled(input),
    ...checkValuationIdentity({
      peTTM: (input as { peTTM?: number }).peTTM,
      pbMRQ: (input as { pbMRQ?: number }).pbMRQ,
    }),
  ];
  return { refId: input.refId, kind: 'financials', findings };
}

/** 对账行情快照（目前只有估值恒等式可判定）。 */
export function reconcileSnapshot(input: SnapshotInput): LedgerEntry {
  const findings: Finding[] = [];

  if (finite(input.lastPrice) && input.lastPrice <= 0) {
    findings.push({
      code: 'nonpositive_price',
      severity: 'block',
      claim: '最新价为正数',
      detail: `最新价 ${input.lastPrice} 非正，行情数据不可用。`,
    });
  }

  findings.push(...checkValuationIdentity({ peTTM: input.peTTM, pbMRQ: input.pbMRQ }));
  return { refId: input.refId, kind: 'snapshot', findings };
}

export interface ReconcileOptions {
  /**
   * 达到哪个严重度即拒绝交付。
   *
   * 默认 `'block'`：只拦"物理上不可能"的结论。
   * `'warn'` 用于严格模式（如发布前审计、或怀疑某数据源时）。
   */
  blockOn?: Severity;
}

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warn: 1, block: 2 };

/** 汇总多个条目为一份账本，并按阈值判定是否拒绝。 */
export function runLedger(entries: LedgerEntry[], opts: ReconcileOptions = {}): Ledger {
  const threshold = SEVERITY_ORDER[opts.blockOn ?? 'block'];
  const findings = entries.flatMap((e) => e.findings);

  const blocked = findings.some((f) => SEVERITY_ORDER[f.severity] >= threshold);
  const ok = !findings.some((f) => f.severity !== 'info');

  return { ok, blocked, entries, findings };
}

/**
 * 把结论渲染成给模型的**拒绝理由**。
 *
 * 为什么必须告诉模型原因：模型需要知道"这批数据不能用"以及为什么，
 * 才能把它归入【无法验证项】而不是换个说法把同一个数字写出来。
 * 只返回 `ok:false` 会让模型自由发挥 —— 那正是我们要避免的。
 */
export function describeFindings(findings: readonly Finding[]): string {
  return findings
    .filter((f) => f.severity !== 'info')
    .map((f) => `- [${f.severity}] ${f.claim}：${f.detail}`)
    .join('\n');
}
