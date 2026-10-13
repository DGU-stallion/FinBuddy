import { describe, it, expect } from 'vitest';
import { deriveViews, type DeriveInput } from './message-view';

/**
 * Seam 12: 消息 → 视图模型（T4 页面状态机）
 *
 * 公共接口：deriveViews(messages, opts) → AssistantView[]
 *
 * 抓到：data part 缺失时崩页、把合规轮次当分析轮次渲染（三栏空壳）、
 *       漏解析角标集合导致全部角标被判失效、流未结束就当作完成。
 * 漏掉：真实 DOM 布局（由组件测试负责）。
 *
 * 关键红线：
 *  - **角标校验集合必须来自 data-refs**；缺失时传空集合（→ 全部失效），
 *    绝不能"猜"集合，否则 ADR-0002 决策 2 的强制校验形同虚设。
 *  - 合规轮次必须走 compliance 分支，不渲染三栏（否则用户看到三列空壳）。
 *  - data part 不完整时不得抛异常（流式渲染中途必然不完整）。
 */

function user(text: string) {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
}
function asst(parts: unknown[], id = 'a1') {
  return { id, role: 'assistant', parts };
}

const STEPS = {
  type: 'data-steps',
  id: 'steps',
  data: { steps: [{ id: 'step-compliance', label: '合规校验', detail: '双保险' }] },
};
const PLAN = {
  type: 'data-plan',
  id: 'plan',
  data: {
    reframedClaim: '中际旭创业绩稳健。',
    intentTags: ['标的: 中际旭创'],
    subQuestions: [{ question: '营收多少？', verificator: 'financials' }],
    fromModel: true,
  },
};
const REFS = {
  type: 'data-refs',
  id: 'refs',
  data: {
    refs: [
      {
        refId: 'ref_1',
        kind: 'financials',
        payload: {
          refId: 'ref_1',
          source: '扶摇 · 利润表/财务指标',
          asOf: Date.UTC(2026, 9, 12),
          isFallback: false,
          baseRevenue: 124519000000,
          revenueBasis: 'TTM',
          netMargin: 35.27,
          grossMargin: 46.25,
          taxRate: 15,
          data: { thscode: '300308.SZ', report: '2026-2' },
        },
      },
    ],
  },
};
const CONTRACT = {
  type: 'data-contract',
  id: 'contract',
  data: {
    ok: true,
    violations: [],
    citations: { cited: ['ref_1'], valid: ['ref_1'], invalid: [], hasAny: true },
  },
};
const FOLLOWUPS = { type: 'data-followups', id: 'followups', data: { questions: ['其一？', '其二？', '其三？'] } };
const BODY = { type: 'text', text: '【支持证据】营收 1245 亿[^ref_1]。', state: 'done' };

describe('deriveViews · 正常分析轮次', () => {
  const input: DeriveInput = {
    messages: [user('中际旭创怎么样'), asst([STEPS, PLAN, BODY, REFS, CONTRACT, FOLLOWUPS])],
  };

  it('解析出全部 data part', () => {
    const [v] = deriveViews(input);
    expect(v.kind).toBe('analysis');
    expect(v.steps).toHaveLength(1);
    expect(v.plan?.reframedClaim).toContain('中际旭创');
    expect(v.plan?.fromModel).toBe(true);
    expect(v.refs).toHaveLength(1);
    expect(v.contract?.ok).toBe(true);
    expect(v.followUps).toHaveLength(3);
    expect(v.body).toContain('营收 1245 亿');
  });

  it('角标校验集合来自 data-refs（有效角标不被误判失效）', () => {
    const [v] = deriveViews(input);
    expect(v.allowedRefIds).toEqual(['ref_1']);
  });

  it('从 refs 注入敏感性参数（T5 参数注入）', () => {
    const [v] = deriveViews(input);
    expect(v.sensitivityParams?.baseRevenue).toBe(124519000000);
    expect(v.sensitivityParams?.netMargin).toBe(35.27);
  });

  it('无降级数据时 degraded 为 null（不虚报降级）', () => {
    expect(deriveViews(input)[0].degraded).toBeNull();
  });

  it('返回用户消息文本供展示', () => {
    const [v] = deriveViews(input);
    expect(v.userText).toBe('中际旭创怎么样');
  });
});

describe('deriveViews · 合规轮次', () => {
  it('识别 fail_closed 层，且不渲染三栏', () => {
    const [v] = deriveViews({
      messages: [
        user('买入吗'),
        asst([
          { type: 'data-compliance', id: 'compliance', data: { layer: 'fail_closed' } },
          { type: 'text', text: '合规校验服务暂时不可用。', state: 'done' },
        ]),
      ],
    });
    expect(v.kind).toBe('compliance');
    expect(v.complianceLayer).toBe('fail_closed');
    expect(v.steps).toHaveLength(0);
    expect(v.refs).toHaveLength(0);
  });

  it('关键词层拦截同样走 compliance 分支', () => {
    const [v] = deriveViews({
      messages: [
        user('满仓干'),
        asst([
          { type: 'data-compliance', id: 'compliance', data: { layer: 'keyword' } },
          { type: 'text', text: '我们转为基本面核验。', state: 'done' },
        ]),
      ],
    });
    expect(v.kind).toBe('compliance');
    expect(v.complianceLayer).toBe('keyword');
  });
});

describe('deriveViews · 健壮性（流式中途必然不完整）', () => {
  it('只有 steps 时其余为默认值，不抛异常', () => {
    const [v] = deriveViews({ messages: [user('x'), asst([STEPS])] });
    expect(v.plan).toBeNull();
    expect(v.refs).toEqual([]);
    expect(v.contract).toBeNull();
    expect(v.followUps).toEqual([]);
    expect(v.allowedRefIds).toEqual([]);
  });

  it('refs 缺失时校验集合为空 → 所有角标失效（绝不猜集合）', () => {
    const [v] = deriveViews({ messages: [user('x'), asst([PLAN, BODY, CONTRACT])] });
    expect(v.allowedRefIds).toEqual([]);
  });

  it('未知 data part 被忽略，不影响解析', () => {
    const [v] = deriveViews({
      messages: [user('x'), asst([{ type: 'data-unknown', data: { a: 1 } }, PLAN])],
    });
    expect(v.plan?.reframedClaim).toContain('中际旭创');
  });

  it('空消息列表返回空数组', () => {
    expect(deriveViews({ messages: [] })).toEqual([]);
  });

  it('只有用户消息（尚无回答）返回空数组', () => {
    expect(deriveViews({ messages: [user('只有我问')] })).toEqual([]);
  });

  it('data part 的 data 形状错误时不抛异常', () => {
    const bad = [
      { type: 'data-steps', data: null },
      { type: 'data-plan', data: 'nope' },
      { type: 'data-refs', data: { refs: 'not-array' } },
      { type: 'data-contract', data: 42 },
      { type: 'data-followups', data: { questions: 'nope' } },
    ];
    expect(() => deriveViews({ messages: [user('x'), asst(bad)] })).not.toThrow();
    const [v] = deriveViews({ messages: [user('x'), asst(bad)] });
    expect(v.steps).toEqual([]);
    expect(v.plan).toBeNull();
    expect(v.refs).toEqual([]);
    expect(v.followUps).toEqual([]);
  });
});

describe('deriveViews · 多轮', () => {
  it('每轮 assistant 各产出一个视图，顺序与消息一致', () => {
    const views = deriveViews({
      messages: [
        user('第一问'),
        asst([PLAN], 'a1'),
        user('第二问'),
        asst([PLAN], 'a2'),
      ],
    });
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.userText)).toEqual(['第一问', '第二问']);
  });

  it('用户消息归属紧随其后的 assistant 轮次（不串轮）', () => {
    const views = deriveViews({
      messages: [
        user('老问题'),
        asst([PLAN], 'a1'),
        user('新问题'),
        asst([{ ...PLAN, data: { ...PLAN.data, reframedClaim: '新命题' } }], 'a2'),
      ],
    });
    expect(views[1].userText).toBe('新问题');
    expect(views[1].plan?.reframedClaim).toBe('新命题');
  });
});

describe('deriveViews · 降级与流式', () => {
  it('检出 L2 降级存证并给出指示灯', () => {
    const degradedRef = {
      type: 'data-refs',
      id: 'refs',
      data: {
        refs: [
          {
            refId: 'ref_2',
            kind: 'snapshot',
            payload: {
              refId: 'ref_2',
              source: 'L2 本地存证 · 扶摇历史快照',
              asOf: Date.UTC(2026, 9, 12),
              isFallback: true,
              fallbackNote: '抓取于 2026-10-12，非实时行情',
            },
          },
        ],
      },
    };
    const [v] = deriveViews({ messages: [user('x'), asst([degradedRef, BODY])] });
    expect(v.degraded).not.toBeNull();
    expect(v.degraded!.text).toContain('降级');
  });

  it('流式中（streaming）标记为未完成', () => {
    const [v] = deriveViews({ messages: [user('x'), asst([STEPS])], streamingMessageId: 'a1' });
    expect(v.streaming).toBe(true);
  });

  it('非流式时 streaming 为 false', () => {
    const [v] = deriveViews({ messages: [user('x'), asst([STEPS])] });
    expect(v.streaming).toBe(false);
  });
});

describe('跨轮存证隔离（T4 Spec 轴评审抓出的静默错配）', () => {
  // 问题：每轮 refId 都从 ref_1 重新编号（lib/refs.ts 按请求实例分配）。
  // 若抽屉总取"最后一轮"的 refs，追问后点击第一轮正文的 [^ref_1]，
  // 会**静默展示最后一轮的 payload**（第一轮中际旭创的角标点开是宁德时代行情）。
  // 更糟：若第一轮 refId 超出最后一轮数量，合法角标会显示"疑似编造引用"。
  it('每一轮的 allowedRefIds 只含该轮自己的存证（跨轮不混用）', () => {
    const turn = (id: string, refId: string, name: string) => ({
      id,
      role: 'assistant',
      parts: [
        { type: 'data-steps', id: 'steps', data: { steps: [] } },
        {
          type: 'data-refs',
          id: 'refs',
          data: {
            refs: [
              {
                refId,
                kind: 'snapshot',
                payload: { refId, source: '扶摇 · 行情/估值快照', asOf: 1, isFallback: false, data: { name, thscode: 'x' } },
              },
            ],
          },
        },
        { type: 'text', text: `【支持证据】${name}[^${refId}]。`, state: 'done' },
      ],
    });

    const views = deriveViews({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '中际旭创' }] },
        turn('a1', 'ref_1', '中际旭创'),
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: '宁德时代' }] },
        turn('a2', 'ref_1', '宁德时代'),
      ] as never,
    });

    expect(views).toHaveLength(2);
    // 两轮都叫 ref_1，但各自的存证必须属于自己的 payload
    expect((views[0].refs[0].payload as { data: { name: string } }).data.name).toBe('中际旭创');
    expect((views[1].refs[0].payload as { data: { name: string } }).data.name).toBe('宁德时代');
    // 且每轮的校验集合就是自己那一条
    expect(views[0].allowedRefIds).toEqual(['ref_1']);
    expect(views[1].allowedRefIds).toEqual(['ref_1']);
  });

  it('第一轮 refId 超出最后一轮数量时，仍按第一轮自己的集合判定有效', () => {
    const views = deriveViews({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q1' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'data-refs',
              id: 'refs',
              data: {
                refs: [
                  { refId: 'ref_1', kind: 'snapshot', payload: { refId: 'ref_1', data: {} } },
                  { refId: 'ref_2', kind: 'financials', payload: { refId: 'ref_2', data: {} } },
                ],
              },
            },
            { type: 'text', text: '正文[^ref_2]', state: 'done' },
          ],
        },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'q2' }] },
        {
          id: 'a2',
          role: 'assistant',
          parts: [
            {
              type: 'data-refs',
              id: 'refs',
              data: { refs: [{ refId: 'ref_1', kind: 'snapshot', payload: { refId: 'ref_1', data: {} } }] },
            },
            { type: 'text', text: '正文[^ref_1]', state: 'done' },
          ],
        },
      ] as never,
    });

    // 第一轮的 ref_2 属于第一轮集合 → 有效（不会被最后一轮的少集合判成编造）
    expect(views[0].allowedRefIds).toContain('ref_2');
    expect(views[1].allowedRefIds).toEqual(['ref_1']);
  });
});

describe('arrivedParts（供时间轴推断真实进度）', () => {
  it('列出该轮已到达的 data part 名（不含 text）', () => {
    const [v] = deriveViews({
      messages: [
        user('x'),
        asst([STEPS, PLAN, BODY]),
      ],
    });
    expect(v.arrivedParts).toContain('data-steps');
    expect(v.arrivedParts).toContain('data-plan');
    expect(v.arrivedParts).not.toContain('data-contract');
    expect(v.arrivedParts.every((p) => p.startsWith('data-'))).toBe(true);
  });

  it('全部到达时含 contract 与 followups', () => {
    const [v] = deriveViews({ messages: [user('x'), asst([STEPS, PLAN, BODY, REFS, CONTRACT, FOLLOWUPS])] });
    expect(v.arrivedParts).toEqual(
      expect.arrayContaining(['data-steps', 'data-plan', 'data-refs', 'data-contract', 'data-followups']),
    );
  });

  it('合规轮次不含任何分析 part', () => {
    const [v] = deriveViews({
      messages: [
        user('买入吗'),
        asst([
          { type: 'data-compliance', id: 'compliance', data: { layer: 'keyword' } },
          { type: 'text', text: 'x', state: 'done' },
        ]),
      ],
    });
    expect(v.arrivedParts).not.toContain('data-plan');
  });
});
