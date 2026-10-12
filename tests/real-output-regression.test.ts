import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { scanPredictionLanguage } from '@/lib/analysis';
import { validateAnalysisOutput } from '@/lib/output-contract';

/**
 * 真实输出回归：合规词表不得在真实模型正文上产生假阳性
 *
 * 背景：T3 code-review 补入共享词表（lib/vocabulary.ts）修复了两处漏拦，
 * 但收紧词表的风险是**误伤真实正文**。真机复跑需要可用 LLM（当前余额耗尽），
 * 因此把充值前抓到的真实输出冻结为 fixture，让词表收紧后能立刻回归。
 *
 * 抓到：词表过宽导致真实正文被误判（例如把"下滑/承压"当成看跌预测）。
 * 漏掉：新模型措辞下的新假阳性（fixture 只覆盖一次真实产出）。
 *
 * 铁律：fixture 是真实产出，**不得为了让测试通过而修改它**。
 *       若冲突，先怀疑词表。
 */

const FIXTURE = path.resolve(__dirname, 'fixtures/real-agent-output.md');

describe('真实模型输出回归', () => {
  const text = fs.readFileSync(FIXTURE, 'utf-8');

  it('fixture 确实是完整的三栏正文（防止 fixture 失效导致测试空转）', () => {
    for (const s of ['命题重构', '支持证据', '反对证据', '无法验证项']) {
      expect(text, `fixture 应含【${s}】`).toContain(`【${s}】`);
    }
    expect(text).toMatch(/\[\^ref_\d+\]/);
  });

  it('合规词表在真实正文上零命中（无假阳性）', () => {
    expect(scanPredictionLanguage(text)).toEqual([]);
  });

  it('契约校验在真实正文上零违规', () => {
    const r = validateAnalysisOutput(text, {
      refIds: ['ref_1', 'ref_2', 'ref_3', 'ref_4'],
      fallbackRefs: [],
      vacuumSubQuestions: [],
    });
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('真实正文的角标全部可溯源（与真机运行一致）', () => {
    const ids = [...text.matchAll(/\[\^(ref_\d+)\]/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(['ref_1', 'ref_2', 'ref_3', 'ref_4']).toContain(id);
  });
});
