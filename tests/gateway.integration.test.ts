import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveTicker } from '../lib/ticker';
import { lookupStockSnapshot } from '../lib/gateway';
import { formatSnapshotForLLM } from '../lib/format';

// 真机集成测试：需要真实 FUYAO_API_KEY。缺失时跳过（不伪造通过）。
const envPath = path.resolve(__dirname, '../.env');
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf-8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const hasKey = Boolean(env.FUYAO_API_KEY) && env.FUYAO_API_KEY.startsWith('sk-');

describe.skipIf(!hasKey)('真机集成：标的解析 → 行情快照 → LLM 格式化', () => {
  it('中际旭创能端到端取到真实行情并格式化为带出处的文本', async () => {
    process.env.FUYAO_API_KEY = env.FUYAO_API_KEY;

    const r = await resolveTicker('中际旭创');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.thscode).toBe('300308.SZ');

    const snap = await lookupStockSnapshot(r.thscode, 'ref_1');
    expect(snap.data.thscode).toBe('300308.SZ');
    expect(typeof snap.data.last_price).toBe('number');
    expect(snap.data.last_price).toBeGreaterThan(0);
    console.log('\n真实行情:', JSON.stringify(snap.data));

    const text = formatSnapshotForLLM(snap);
    expect(text).toContain('300308.SZ');
    expect(text).toContain('扶摇');
    console.log('\nLLM 上下文:\n' + text);
  }, 30000);

  it('未识别标的返回结构化失败而非猜测', async () => {
    process.env.FUYAO_API_KEY = env.FUYAO_API_KEY;
    const r = await resolveTicker('不存在的公司zzzqqq');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  }, 30000);
});
