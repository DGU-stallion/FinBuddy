import { describe, it, expect } from 'vitest';
import {
  tokenizeCitations,
  splitEvidence,
  summarizeRef,
  detectDegraded,
  EVIDENCE_COLUMNS,
} from './evidence';

/**
 * Seam 8: 证据渲染逻辑（T4 三栏 + 角标强制校验 + 存证抽屉）
 *
 * 公共接口：
 *  - tokenizeCitations(text, allowedRefIds): 把正文切成「纯文本 / 角标」token 序列，
 *    每个角标自带 valid 标记 —— 这是 ADR-0002 决策 2「前端强制校验」的落点。
 *  - splitEvidence(text): 把正文按【支持证据】【反对证据】【无法验证项】拆成三栏。
 *  - summarizeRef(payload, kind): 把工具原始 payload 转成人类可读摘要（抽屉默认层）。
 *  - detectDegraded(refs): 检出 L2 降级存证，产出必须显式渲染的指示灯文案。
 *
 * 抓到：编造角标、三栏缺失/为空、降级数据被当作实时陈述、抽屉无摘要可读。
 * 漏掉：正文与 payload 的语义对应关系（不可机械判定，只能靠人读原文）。
 *
 * 关键红线（ADR-0002 决策 2、4）：
 *  - 角标不在本轮返回集合内 → valid=false，前端必须渲染灰色「引用失效」且不可点击。
 *  - 降级数据必须显著标注，绝不冒充实时。
 *  - 抽屉默认层是人类可读摘要，原始 JSON 只在可折叠的第二层。
 */

describe('tokenizeCitations（角标强制校验的落点）', () => {
  it('按顺序切出文本与角标 token', () => {
    const toks = tokenizeCitations('营收 1245 亿[^ref_1]，传闻[^ref_9]。', ['ref_1']);
    expect(toks.map((t) => t.type)).toEqual([
      'text',
      'citation',
      'text',
      'citation',
      'text',
    ]);
    expect(toks[1]).toMatchObject({ type: 'citation', refId: 'ref_1', valid: true });
    expect(toks[3]).toMatchObject({ type: 'citation', refId: 'ref_9', valid: false });
  });

  it('文本内容不丢字（拼接后等于原文去掉角标）', () => {
    const text = '营收 1245 亿[^ref_1]，传闻[^ref_9]。';
    const toks = tokenizeCitations(text, ['ref_1']);
    const joined = toks.map((t) => (t.type === 'text' ? t.value : '')).join('');
    expect(joined).toBe('营收 1245 亿，传闻。');
  });

  it('不在本轮返回集合内的角标一律标记失效（编造即失效）', () => {
    const toks = tokenizeCitations('官方已澄清[^ref_7]', ['ref_1', 'ref_2']);
    const cit = toks.find((t) => t.type === 'citation');
    expect(cit).toMatchObject({ refId: 'ref_7', valid: false });
  });

  it('工具全挂、无任何 refId 时任何角标都失效', () => {
    const toks = tokenizeCitations('数据显示增长[^ref_1]', []);
    const cites = toks.filter((t) => t.type === 'citation');
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ refId: 'ref_1', valid: false });
  });

  it('无角标时返回单段文本', () => {
    const toks = tokenizeCitations('公司经营正常。', ['ref_1']);
    expect(toks).toEqual([{ type: 'text', value: '公司经营正常。' }]);
  });

  it('不误抓脚注与普通方括号（与 lib/citations.ts 同一规范）', () => {
    const toks = tokenizeCitations('见[^ref_1]，脚注[^1]，数组[0,1]', ['ref_1']);
    const cites = toks.filter((t) => t.type === 'citation');
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ refId: 'ref_1' });
  });

  it('确定性：同输入同输出', () => {
    const a = tokenizeCitations('x[^ref_1]y', ['ref_1']);
    const b = tokenizeCitations('x[^ref_1]y', ['ref_1']);
    expect(a).toEqual(b);
  });
});

describe('splitEvidence（三栏拆分）', () => {
  const body = [
    '【命题重构】中际旭创业绩稳健。',
    '【支持证据】营收 1245 亿[^ref_1]。',
    '【反对证据】毛利率环比下滑[^ref_2]。',
    '【无法验证项】大客户集中度尚未披露[^ref_3]。',
    '【敏感性测算】见下方卡片。',
  ].join('\n');

  it('拆出三栏内容，顺序为主题顺序', () => {
    const cols = splitEvidence(body);
    expect(cols.map((c) => c.name)).toEqual([...EVIDENCE_COLUMNS]);
    expect(cols[0].content).toContain('营收 1245 亿');
    expect(cols[1].content).toContain('毛利率环比下滑');
    expect(cols[2].content).toContain('大客户集中度尚未披露');
  });

  it('分栏缺失时 content 为 null（与「存在但为空」区分）', () => {
    const cols = splitEvidence('【支持证据】有内容。');
    const opposing = cols.find((c) => c.name === '反对证据');
    expect(opposing?.content).toBeNull();
  });

  it('三栏始终返回三条（供前端固定三列布局）', () => {
    expect(splitEvidence('')).toHaveLength(3);
  });
});

describe('summarizeRef（存证抽屉默认层：人类可读摘要）', () => {
  it('行情快照：标题含标的名与代码，字段为可读中文', () => {
    const s = summarizeRef(
      {
        refId: 'ref_4',
        source: '扶摇 · 行情/估值快照',
        asOf: Date.UTC(2026, 9, 12),
        isFallback: false,
        data: {
          thscode: '300750.SZ',
          name: '宁德时代',
          last_price: 298.38,
          price_change_ratio_pct: 0.211587,
          pe_ttm: 16.243252,
        },
      },
      'snapshot',
    );
    expect(s.title).toContain('宁德时代');
    expect(s.title).toContain('300750.SZ');
    const labels = s.fields.map((f) => f.label).join();
    expect(labels).toContain('最新价');
    expect(labels).toContain('PE');
    // 不得出现 undefined / null 字面量
    expect(s.fields.map((f) => f.value).join()).not.toMatch(/undefined|null|NaN/);
  });

  it('财务参数：标注口径与时点（不得静默换口径，ADR-0001 决策 4）', () => {
    const s = summarizeRef(
      {
        refId: 'ref_3',
        source: '扶摇 · 利润表/财务指标',
        asOf: Date.UTC(2026, 9, 12),
        isFallback: false,
        baseRevenue: 1112821442000,
        revenueBasis: 'TTM',
        netMargin: 16.9837,
        taxRate: 15,
        data: { thscode: '300750.SZ', report: '2026-2' },
      },
      'financials',
    );
    expect(s.fields.map((f) => f.label).join()).toContain('基准营收');
    expect(s.fields.map((f) => f.value).join()).toContain('TTM');
    expect(s.fields.map((f) => f.label).join()).toContain('报告期');
  });

  it('公告检索：命中条数与逐条标题日期', () => {
    const s = summarizeRef(
      {
        refId: 'ref_1',
        source: 'iFinD · 公告检索',
        asOf: Date.UTC(2026, 9, 12),
        isFallback: false,
        vacuum: false,
        items: [
          { title: '关于固态电池的公告', snippet: '片段', date: '2026-08-01' },
          { title: '业绩说明会记录', snippet: '片段', date: '2026-07-15' },
        ],
      },
      'announcements',
    );
    expect(s.title).toContain('2');
    expect(s.fields.some((f) => f.value.includes('关于固态电池的公告'))).toBe(true);
  });

  it('真空期公告：摘要必须显式说明「未返回结果」，不得留空', () => {
    const s = summarizeRef(
      { refId: 'ref_2', source: 'iFinD · 公告检索', asOf: Date.UTC(2026, 9, 12), isFallback: false, vacuum: true, items: [] },
      'announcements',
    );
    expect(s.title + s.fields.map((f) => f.value).join()).toMatch(/未返回|真空|无结果/);
  });

  it('缺失字段写「缺失」而非 undefined（题目红线：不得静默省略）', () => {
    const s = summarizeRef({ refId: 'ref_9', source: 'x', asOf: 0, isFallback: false, data: {} }, 'snapshot');
    expect(s.fields.map((f) => f.value).join()).not.toMatch(/undefined/);
  });

  it('未知形状不抛异常（稳健性）', () => {
    expect(() => summarizeRef(null, 'unknown')).not.toThrow();
    expect(() => summarizeRef({}, 'unknown')).not.toThrow();
  });
});

describe('detectDegraded（L2 降级指示灯）', () => {
  it('存在 isFallback 时产出指示灯，且含抓取日期与非实时声明', () => {
    const d = detectDegraded([
      {
        refId: 'ref_1',
        kind: 'snapshot',
        payload: {
          refId: 'ref_1',
          source: 'L2 本地存证 · 扶摇历史快照',
          asOf: Date.UTC(2026, 9, 12),
          isFallback: true,
          fallbackNote: '抓取于 2026-10-12，非实时行情',
        },
      },
    ]);
    expect(d).not.toBeNull();
    expect(d!.refIds).toEqual(['ref_1']);
    expect(d!.text).toMatch(/降级|非实时/);
    expect(d!.text).toContain('2026-10-12');
  });

  it('全部为实时数据时返回 null（不虚报降级）', () => {
    const d = detectDegraded([
      { refId: 'ref_1', kind: 'snapshot', payload: { refId: 'ref_1', source: '扶摇 · 行情/估值快照', asOf: 1, isFallback: false } },
    ]);
    expect(d).toBeNull();
  });

  it('无 refs 时返回 null', () => {
    expect(detectDegraded([])).toBeNull();
  });
});

describe('summarizeRef · 视觉规范（红涨绿跌，票面要求）', () => {
  it('涨幅为正标红、为负标绿（A 股惯例）', () => {
    const up = summarizeRef(
      { refId: 'r', source: 's', asOf: 1, isFallback: false, data: { price_change_ratio_pct: 2.5 } },
      'snapshot',
    );
    expect(up.fields.find((f) => f.label === '涨跌幅')?.tone).toBe('up');

    const down = summarizeRef(
      { refId: 'r', source: 's', asOf: 1, isFallback: false, data: { price_change_ratio_pct: -6.41 } },
      'snapshot',
    );
    expect(down.fields.find((f) => f.label === '涨跌幅')?.tone).toBe('down');
  });

  it('涨跌幅带正负号', () => {
    const up = summarizeRef(
      { refId: 'r', source: 's', asOf: 1, isFallback: false, data: { price_change_ratio_pct: 2.5 } },
      'snapshot',
    );
    expect(up.fields.find((f) => f.label === '涨跌幅')?.value).toBe('+2.50%');
  });

  it('零涨跌不着色（不虚报方向）', () => {
    const z = summarizeRef(
      { refId: 'r', source: 's', asOf: 1, isFallback: false, data: { price_change_ratio_pct: 0 } },
      'snapshot',
    );
    expect(z.fields.find((f) => f.label === '涨跌幅')?.tone).toBeUndefined();
  });
});

describe('summarizeRef · 税率来源标注（不得让推导值冒充接口字段）', () => {
  it('所得税率标注为"推导"并说明口径（T4 Spec 轴评审缺陷）', () => {
    const s = summarizeRef(
      {
        refId: 'ref_3',
        source: '扶摇 · 利润表/财务指标',
        asOf: 1,
        isFallback: false,
        baseRevenue: 1e11,
        revenueBasis: 'TTM',
        netMargin: 10,
        grossMargin: 20,
        taxRate: 14.84,
        data: {},
      },
      'financials',
    );
    const tax = s.fields.find((f) => f.label.includes('所得税率'));
    expect(tax).toBeDefined();
    // 必须是推导口径，而不是让人误以为是接口直出的字段
    expect(tax!.label).toContain('有效');
    expect(tax!.value).toContain('14.84');
    expect(tax!.value).toMatch(/推导|计算|Σ|税前/);
  });

  it('税率缺失时写"缺失"，不得回退默认值', () => {
    const s = summarizeRef(
      { refId: 'ref_9', source: 'x', asOf: 1, isFallback: false, baseRevenue: 1e8, revenueBasis: 'TTM', netMargin: 10, data: {} },
      'financials',
    );
    const tax = s.fields.find((f) => f.label.includes('所得税率'));
    expect(tax!.value).toBe('缺失');
  });
});

describe('流式期间角标状态：待校验 ≠ 引用失效（T4 Spec 轴评审指出）', () => {
  // 背景：data-refs 在 consumeStream() 之后才写入，而正文逐字到达。
  // 结果：流式期间（真机约 20s）所有合法角标都显示为灰色删除线的"引用失效"，
  // 流结束才整体翻蓝。演示时肉眼可见，容易被评委误读为校验误报。
  //
  // 修法不是"放宽校验"（那会让编造角标漏网），而是增加一个明确的**中间态**：
  // 集合尚未到达时标为 pending（"校验中"），只有确实拿到了集合且不在其中
  // 才判 invalid。这样既不放宽红线，也不再误导。
  it('集合未到达（流式中）时标记为 pending，而非 invalid', () => {
    const toks = tokenizeCitations('营收 1245 亿[^ref_1]。', []).filter((t) => t.type === 'citation');
    expect(toks[0]).toMatchObject({ refId: 'ref_1', status: 'pending' });
  });

  it('集合已到达且命中 → valid', () => {
    const toks = tokenizeCitations('营收[^ref_1]', ['ref_1']).filter((t) => t.type === 'citation');
    expect(toks[0]).toMatchObject({ refId: 'ref_1', status: 'valid' });
  });

  it('集合已到达但未命中 → invalid（红线不变：编造必须判失效）', () => {
    const toks = tokenizeCitations('编造[^ref_7]', ['ref_1']).filter((t) => t.type === 'citation');
    expect(toks[0]).toMatchObject({ refId: 'ref_7', status: 'invalid' });
  });

  it('空正文集合且**已确认本轮无工具返回**时才是 invalid（终态）', () => {
    // 终态判定：调用方传 allowPending=false 表示"集合已定，不会再变"
    const toks = tokenizeCitations('x[^ref_1]', [], { refsSettled: true }).filter((t) => t.type === 'citation');
    expect(toks[0]).toMatchObject({ refId: 'ref_1', status: 'invalid' });
  });

  it('pending 与 invalid 不得混淆（hasAny/valid/invalid 仍只统计确定态）', () => {
    const toks = tokenizeCitations('a[^ref_1] b[^ref_2]', ['ref_1']);
    const cites = toks.filter((t) => t.type === 'citation');
    expect(cites.map((c) => (c as { status: string }).status)).toEqual(['valid', 'invalid']);
  });
});
