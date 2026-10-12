import { describe, it, expect } from 'vitest';
import { normalizeTickerQuery, resolveTicker, type TickerResolution } from './ticker';

/**
 * Seam 1: resolveTicker(query) -> thscode | null
 * 公共接口：输入自然语言标的（中文名/6位代码/带后缀代码），输出规范 thscode 或结构化失败。
 * 抓到：查询规范化逻辑（后缀推断、去空格、大小写）。
 * 漏掉：扶摇检索接口的真实网络行为（属于集成层）。
 */

describe('normalizeTickerQuery', () => {
  it('已是规范 thscode 时原样返回', () => {
    expect(normalizeTickerQuery('300308.SZ')).toBe('300308.SZ');
  });

  it('小写后缀规范为大写', () => {
    expect(normalizeTickerQuery('300308.sz')).toBe('300308.SZ');
  });

  it('去除首尾空白', () => {
    expect(normalizeTickerQuery('  300308.SZ  ')).toBe('300308.SZ');
  });

  it('纯 6 位代码按 6/9 开头推断上交所后缀', () => {
    expect(normalizeTickerQuery('600519')).toBe('600519.SH');
    expect(normalizeTickerQuery('688981')).toBe('688981.SH');
  });

  it('纯 6 位代码按 0/3 开头推断深交所后缀', () => {
    expect(normalizeTickerQuery('300308')).toBe('300308.SZ');
    expect(normalizeTickerQuery('000001')).toBe('000001.SZ');
  });

  it('中文名或非代码片段不做后缀推断，原样返回供检索', () => {
    expect(normalizeTickerQuery('中际旭创')).toBe('中际旭创');
  });
});

describe('resolveTicker (注入 fetch，测行为不测网络)', () => {
  const okResponse = (item: unknown[]) => ({
    ok: true,
    json: async () => ({ code: 0, message: 'success', data: { timestamp: 1, item } }),
  }) as unknown as Response;

  it('唯一命中时返回该 thscode 与名称', async () => {
    const fetchFn = (async () =>
      okResponse([
        { thscode: '300308.SZ', ticker: '300308', name: '中际旭创', asset_type: 'a-share' },
      ])) as unknown as typeof fetch;

    const r: TickerResolution = await resolveTicker('中际旭创', { fetchFn, apiKey: 'k' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.thscode).toBe('300308.SZ');
      expect(r.name).toBe('中际旭创');
    }
  });

  it('零命中时返回结构化"未识别"，而非抛异常、而非猜一个', async () => {
    const fetchFn = (async () => okResponse([])) as unknown as typeof fetch;

    const r = await resolveTicker('不存在的公司xyz', { fetchFn, apiKey: 'k' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  it('多个候选时取第一个但把候选列表带回，供上层显式处理', async () => {
    const fetchFn = (async () =>
      okResponse([
        { thscode: '601318.SH', ticker: '601318', name: '中国平安', asset_type: 'a-share' },
        { thscode: '000001.SZ', ticker: '000001', name: '平安银行', asset_type: 'a-share' },
      ])) as unknown as typeof fetch;

    const r = await resolveTicker('平安', { fetchFn, apiKey: 'k' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.thscode).toBe('601318.SH');
      expect(r.candidates).toHaveLength(2);
    }
  });

  it('接口报错时返回结构化 upstream_error，不静默当作"未找到"', async () => {
    const fetchFn = (async () => ({
      ok: false,
      status: 429,
    })) as unknown as typeof fetch;

    const r = await resolveTicker('中际旭创', { fetchFn, apiKey: 'k' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('upstream_error');
  });
});
