import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 真机诊断：对账器在**真实数据**上到底触发什么？
 *
 * 为什么需要这个文件：对账器全部 28 条单测都跑在**合成数据**上。
 * 合成数据证明的是"规则按我设想的方式工作"，证明不了
 * "上游真实返回能否触发它" —— 而本次缺陷的教训恰恰是这两者不同
 * （`sumTTM` 的单测用合成数据验证加法，加法确实没错，错的是输入）。
 *
 * 所以本文件不打断言式"应该通过"，而是**打印真实对账结论**，
 * 让人看见真实数据上发生了什么。唯一硬断言：不得抛出异常。
 *
 * 前置：.env 中有 FUYAO_API_KEY。无 key 时整组跳过并显式声明"未验证"。
 */

function loadKey(): string | null {
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = raw.match(/^FUYAO_API_KEY=(.+)$/m);
    return m && m[1].trim() !== '' ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const key = loadKey();
if (!key) {
  console.warn(
    '\n⚠️  跳过真机对账诊断（tests/reconcile-live.test.ts）—— 未验证。\n' +
      '    原因：缺少 .env 中的 FUYAO_API_KEY。\n' +
      '    这不是通过，只是前置条件不满足。\n',
  );
}

describe.skipIf(!key)('真机：对账器在真实数据上的行为', () => {
  it('宁德时代 / 中际旭创：打印真实逐期序列与对账结论', async () => {
    process.env.FUYAO_API_KEY = key!;
    const { lookupFinancialReport } = await import('../lib/gateway');
    const { reconcileFinancials } = await import('../lib/reconcile');

    for (const [code, name] of [
      ['300750.SZ', '宁德时代'],
      ['300308.SZ', '中际旭创'],
    ] as const) {
      const r = await lookupFinancialReport(code, 'ref_1');

      console.log(`\n===== ${name} (${code}) =====`);
      console.log(`基准营收      = ${(r.baseRevenue / 1e8).toFixed(0)} 亿元  [${r.revenueBasis}]`);
      console.log(`净利率 / 毛利率 = ${r.netMargin}% / ${r.grossMargin}%`);
      console.log(`有效税率      = ${r.taxRate?.toFixed(2)}%`);
      console.log(
        `TTM 净利润    = ${r.netProfitTTM !== undefined ? (r.netProfitTTM / 1e8).toFixed(0) + ' 亿元' : '(未提供)'}`,
      );
      console.log(
        `逐期营收(e8)  = ${
          (r.revenueSeries ?? [])
            .map((p) => `${p.year ?? '?'}${p.period ?? '?'}=${(p.revenue / 1e8).toFixed(0)}`)
            .join(', ') || '(未提供序列)'
        }`,
      );

      const entry = reconcileFinancials({
        refId: 'ref_1',
        baseRevenue: r.baseRevenue,
        revenueBasis: r.revenueBasis,
        netMargin: r.netMargin,
        grossMargin: r.grossMargin,
        taxRate: r.taxRate,
        netProfitTTM: r.netProfitTTM,
        revenueSeries: r.revenueSeries ?? [],
      });

      if (entry.findings.length === 0) {
        console.log('对账结论      = ✅ 无问题');
      } else {
        for (const f of entry.findings) {
          console.log(`对账结论      = [${f.severity}] ${f.code}`);
          console.log(`                ${f.detail}`);
        }
      }

      // 唯一硬断言：真实数据不得让对账器崩溃（形状可能与我设想的不同）
      expect(entry.refId).toBe('ref_1');
    }
  }, 60_000);
});
