import { describe, it, expect } from 'vitest';
import { buildContextSummary, summarizeFacts } from './context-summary';

/**
 * Seam 10: 多轮上下文结构化摘要（T5，spec 交互决策「多轮上下文」）
 *
 * 公共接口：
 *  - buildContextSummary(messages): 从历史消息的 data part 里抽出
 *    「本轮标的 + 已确认事实」，产出可注入下一轮的紧凑摘要
 *  - summarizeFacts(refs): 从存证 payload 里提炼已确认事实（数值可回溯）
 *
 * 抓到：把完整对话塞进上下文（爆 token / 噪音）、标的多轮漂移、
 *       把模型的自述当成"已确认事实"（事实必须来自工具 payload）。
 * 漏掉：多轮之间的语义指代（"它""这家公司"）解析，属模型能力范围。
 *
 * 关键红线（spec 交互决策）：只带**结构化结论摘要**，不带完整对话历史。
 * 已确认事实必须源自工具原始 payload，不得采信模型正文里的转述。
 */

/** 构造最小 UIMessage 形状（只需测试用到的字段）。 */
function msg(role: string, parts: unknown[]) {
  return { id: 'm1', role, parts } as never;
}

describe('summarizeFacts（已确认事实必须来自工具 payload）', () => {
  it('从行情快照提炼价格与估值', () => {
    const facts = summarizeFacts([
      {
        refId: 'ref_4',
        kind: 'snapshot',
        payload: {
          refId: 'ref_4',
          source: '扶摇 · 行情/估值快照',
          asOf: Date.UTC(2026, 9, 12),
          isFallback: false,
          data: { thscode: '300750.SZ', name: '宁德时代', last_price: 298.38, pe_ttm: 16.243252 },
        },
      },
    ]);
    const joined = facts.map((f) => `${f.label}${f.value}`).join();
    expect(joined).toContain('宁德时代');
    expect(joined).toContain('298.38');
    expect(facts.every((f) => f.refId === 'ref_4')).toBe(true);
  });

  it('从财务参数提炼营收与利润率（含口径）', () => {
    const facts = summarizeFacts([
      {
        refId: 'ref_3',
        kind: 'financials',
        payload: {
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
      },
    ]);
    const joined = facts.map((f) => `${f.label}${f.value}`).join();
    expect(joined).toContain('TTM');
    expect(joined).toContain('16.98');
  });

  it('公告真空期记为"未返回结果"事实（不得脑补成结论）', () => {
    const facts = summarizeFacts([
      {
        refId: 'ref_2',
        kind: 'announcements',
        payload: { refId: 'ref_2', source: 'iFinD · 公告检索', asOf: 1, isFallback: false, vacuum: true, items: [] },
      },
    ]);
    expect(facts.map((f) => f.value).join()).toMatch(/未返回|真空/);
  });

  it('每条事实都带 refId（可回溯到原始字段）', () => {
    const facts = summarizeFacts([
      { refId: 'ref_1', kind: 'snapshot', payload: { refId: 'ref_1', data: { name: 'X', last_price: 1 } } },
    ]);
    expect(facts.every((f) => typeof f.refId === 'string' && f.refId.length > 0)).toBe(true);
  });

  it('无 refs 时返回空数组（不伪造事实）', () => {
    expect(summarizeFacts([])).toEqual([]);
  });
});

describe('buildContextSummary（只带结构化摘要，不带完整对话）', () => {
  it('从上一轮 assistant 消息的 data part 抽出标的与已确认事实', () => {
    const messages = [
      msg('user', [{ type: 'text', text: '宁德时代固态电池跳票了吗？' }]),
      msg('assistant', [
        {
          type: 'data-plan',
          data: {
            reframedClaim: '宁德时代固态电池量产未出现官方确认的重大延期。',
            intentTags: ['标的: 宁德时代', '事件: 固态电池量产跳票传闻'],
            subQuestions: [],
          },
        },
        {
          type: 'data-refs',
          data: {
            refs: [
              {
                refId: 'ref_4',
                kind: 'snapshot',
                payload: { refId: 'ref_4', isFallback: false, data: { name: '宁德时代', thscode: '300750.SZ', last_price: 298.38 } },
              },
            ],
          },
        },
      ]),
    ];

    const s = buildContextSummary(messages as never);
    expect(s).not.toBeNull();
    expect(s!.subject).toBe('宁德时代');
    expect(s!.claim).toContain('固态电池');
    expect(s!.facts.length).toBeGreaterThan(0);
  });

  it('摘要文本紧凑：不含助手正文长文（只带结构化结论）', () => {
    const longBody = '【支持证据】' + '很长的分析正文。'.repeat(300);
    const messages = [
      msg('assistant', [
        { type: 'text', text: longBody },
        {
          type: 'data-plan',
          data: { reframedClaim: '命题', intentTags: ['标的: 中际旭创'], subQuestions: [] },
        },
      ]),
    ];
    const s = buildContextSummary(messages as never);
    expect(s).not.toBeNull();
    // 摘要里绝不能夹带正文原文
    expect(s!.toPromptText()).not.toContain('很长的分析正文');
    expect(s!.toPromptText().length).toBeLessThan(1200);
  });

  it('无历史（首轮）返回 null', () => {
    expect(buildContextSummary([] as never)).toBeNull();
  });

  it('历史里没有 data-plan 时返回 null（不猜标的）', () => {
    const messages = [msg('assistant', [{ type: 'text', text: '你好' }])];
    expect(buildContextSummary(messages as never)).toBeNull();
  });

  it('取最近一轮的计划（标的不被更早的轮次污染）', () => {
    const messages = [
      msg('assistant', [
        { type: 'data-plan', data: { reframedClaim: '旧命题', intentTags: ['标的: 中际旭创'], subQuestions: [] } },
      ]),
      msg('assistant', [
        { type: 'data-plan', data: { reframedClaim: '新命题', intentTags: ['标的: 宁德时代'], subQuestions: [] } },
      ]),
    ];
    const s = buildContextSummary(messages as never);
    expect(s!.subject).toBe('宁德时代');
    expect(s!.claim).toBe('新命题');
  });

  it('toPromptText 含标的、命题与已确认事实（供注入下一轮 system）', () => {
    const messages = [
      msg('assistant', [
        { type: 'data-plan', data: { reframedClaim: '命题A', intentTags: ['标的: 中际旭创'], subQuestions: [] } },
        {
          type: 'data-refs',
          data: { refs: [{ refId: 'ref_1', kind: 'snapshot', payload: { refId: 'ref_1', data: { name: '中际旭创', last_price: 724.47 } } }] },
        },
      ]),
    ];
    const t = buildContextSummary(messages as never)!.toPromptText();
    expect(t).toContain('中际旭创');
    expect(t).toContain('命题A');
    expect(t).toContain('724.47');
  });

  it('确定性：同输入同输出', () => {
    const messages = [
      msg('assistant', [
        { type: 'data-plan', data: { reframedClaim: '命题A', intentTags: ['标的: 中际旭创'], subQuestions: [] } },
      ]),
    ];
    expect(buildContextSummary(messages as never)!.toPromptText()).toBe(
      buildContextSummary(messages as never)!.toPromptText(),
    );
  });
});
