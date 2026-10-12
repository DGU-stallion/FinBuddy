import { describe, it, expect, vi } from 'vitest';
import { lookupStockSnapshot } from '@/lib/gateway';
import { validateAnalysisOutput } from '@/lib/output-contract';
import { formatSnapshotForLLM } from '@/lib/format';
import { listFallbackCases } from '@/lib/fallback';

/**
 * T3 缺口补齐：L2 降级 → 正文"非实时 + 抓取日期"声明链路
 *
 * code-review Spec 轴指出：真实流的"降级→正文声明"链路未被测试，且
 * missing_fallback_disclosure 在生产几乎不可达（L2 仅覆盖预置案例）。
 * 这里用注入的失败 fuyao 真实触发 L2，再验证契约：
 * 降级数据若无显式声明，必须报违规（ADR-0001 决策 3：绝不冒充实时行情）。
 *
 * 抓到：降级标记丢失、正文把历史数据当实时陈述、契约放过未声明的降级数据。
 * 漏掉：真实网络的超时行为（由 gateway.integration.test.ts 覆盖）。
 */

const PRESET = listFallbackCases()[0]; // 中际旭创
const FUYAO_DOWN = {
  fuyao: (async () => {
    throw new Error('扶摇不可用');
  }) as never,
  ifind: (async () => {
    throw new Error('不应调用');
  }) as never,
};

/** 与 lib/output-contract.ts 内部实现保持一致的 UTC 日期格式。 */
function utcDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

describe('L2 降级 → 正文声明 链路', () => {
  it('扶摇不可用时预置案例降级，且携带 isFallback 与非实时说明', async () => {
    const snap = await lookupStockSnapshot(PRESET.thscode, 'ref_1', FUYAO_DOWN);
    expect(snap.isFallback).toBe(true);
    expect(snap.fallbackNote).toBeTruthy();

    // 格式化给 LLM 的文本必须自带警示，模型无法"忘记"数据是非实时的
    const text = formatSnapshotForLLM(snap);
    expect(text).toContain('非实时');
    expect(text).toContain('降级存证');
  });

  it('降级数据未在正文声明时，契约报 missing_fallback_disclosure', async () => {
    const snap = await lookupStockSnapshot(PRESET.thscode, 'ref_1', FUYAO_DOWN);
    const fb = { refId: 'ref_1', asOf: snap.asOf, note: snap.fallbackNote };

    // 正文把降级数据当成正常实时数据陈述（未声明非实时、无抓取日期）
    const noDisclosure = `【命题重构】
中际旭创当前业绩强劲。

【支持证据】
- 最新价 ${snap.data.last_price} 元[^ref_1]。

【反对证据】
- 现金流承压[^ref_1]。

【无法验证项】
- 客户集中度无法核验。

【敏感性测算】
基于 TTM 营收。`;

    const r = validateAnalysisOutput(noDisclosure, {
      refIds: ['ref_1'],
      fallbackRefs: [fb],
      vacuumSubQuestions: [],
    });
    expect(r.violations.map((v) => v.code)).toContain('missing_fallback_disclosure');
  });

  it('正文显式声明非实时与抓取日期后，契约通过', async () => {
    const snap = await lookupStockSnapshot(PRESET.thscode, 'ref_1', FUYAO_DOWN);
    const disclosed = `⚠️ 本次行情为降级存证数据，非实时行情，抓取日期 ${utcDate(snap.asOf)}。

【命题重构】
中际旭创当前业绩强劲。

【支持证据】
- 最新价 ${snap.data.last_price} 元（降级存证）[^ref_1]。

【反对证据】
- 现金流承压[^ref_1]。

【无法验证项】
- 客户集中度无法核验。

【敏感性测算】
基于 TTM 营收。`;

    const r = validateAnalysisOutput(disclosed, {
      refIds: ['ref_1'],
      fallbackRefs: [{ refId: 'ref_1', asOf: snap.asOf, note: snap.fallbackNote }],
      vacuumSubQuestions: [],
    });
    expect(r.violations.map((v) => v.code)).not.toContain('missing_fallback_disclosure');
  });

  it('只声明"非实时"但漏掉抓取日期，仍然报违规（两项都要）', async () => {
    const snap = await lookupStockSnapshot(PRESET.thscode, 'ref_1', FUYAO_DOWN);
    const partial = `本次数据非实时。

【命题重构】
x

【支持证据】
- 最新价[^ref_1]。

【反对证据】
- 现金流承压[^ref_1]。

【无法验证项】
- 客户集中度无法核验。

【敏感性测算】
基于 TTM 营收。`;

    const r = validateAnalysisOutput(partial, {
      refIds: ['ref_1'],
      fallbackRefs: [{ refId: 'ref_1', asOf: snap.asOf }],
      vacuumSubQuestions: [],
    });
    expect(r.violations.map((v) => v.code)).toContain('missing_fallback_disclosure');
  });

  it('非预置案例不降级：上游失败直接抛错（自由查询不走 L2）', async () => {
    await expect(lookupStockSnapshot('600519.SH', 'ref_1', FUYAO_DOWN)).rejects.toThrow();
  });
});
