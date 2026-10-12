import { describe, it, expect } from 'vitest';
import { extractCitations, checkCitations } from './citations';

/**
 * Seam 4: 引用角标校验（ADR-0002 决策 2）
 *
 * 公共接口：
 *  - extractCitations(text): 从正文抽取所有 [^ref_X] 角标 id（去重，保持出现顺序）
 *  - checkCitations(text, allowed): 与本轮工具实际返回的 refId 集合比对，
 *    分出 valid（可点击）与 invalid（前端渲染为灰色"引用失效"，不响应点击）
 *
 * 抓到：模型编造 refId、引用错配、同一角标重复出现。
 * 漏掉：refId 与事实语义是否真的对应（不可测，只能靠工具返回原文比对）。
 *
 * 关键红线：角标只能取自本轮工具实际返回的集合，编造即失效。
 * 校验必须发生在渲染前（服务端与前端共用），不信正文转述。
 */

describe('extractCitations', () => {
  it('抽取正文中的角标 id', () => {
    const text = '营收 1245.19 亿元[^ref_1]，净利率 35.27%[^ref_2]。';
    expect(extractCitations(text)).toEqual(['ref_1', 'ref_2']);
  });

  it('去重并保持首次出现顺序', () => {
    const text = 'A[^ref_2] B[^ref_1] C[^ref_2]';
    expect(extractCitations(text)).toEqual(['ref_2', 'ref_1']);
  });

  it('无角标时返回空数组', () => {
    expect(extractCitations('这是一段没有任何引用的文字。')).toEqual([]);
  });

  it('不误抓 Markdown 脚注定义或其他方括号语法', () => {
    const text = '见[^ref_1]。链接[文本](url)，脚注[^1]，数组 [0, 1]。';
    expect(extractCitations(text)).toEqual(['ref_1']);
  });
});

describe('checkCitations', () => {
  it('全部命中本轮工具返回集合时，无可疑角标', () => {
    const text = '营收 1245.19 亿元[^ref_1]，净利率 35.27%[^ref_2]。';
    const r = checkCitations(text, ['ref_1', 'ref_2']);
    expect(r.cited).toEqual(['ref_1', 'ref_2']);
    expect(r.invalid).toEqual([]);
    expect(r.hasAny).toBe(true);
  });

  it('编造的 refId 被判定为失效引用（前端灰标"引用失效"）', () => {
    const text = '官方已澄清传闻[^ref_7]，营收 1245.19 亿元[^ref_1]。';
    const r = checkCitations(text, ['ref_1']);
    expect(r.invalid).toEqual(['ref_7']);
    expect(r.valid).toEqual(['ref_1']);
  });

  it('本轮工具全部失败、无任何 refId 时，任何角标都是编造', () => {
    const r = checkCitations('数据显示增长[^ref_1]', []);
    expect(r.cited).toEqual(['ref_1']);
    expect(r.invalid).toEqual(['ref_1']);
    expect(r.valid).toEqual([]);
  });

  it('正文无角标时 hasAny=false（供契约层判断是否该挂角标）', () => {
    const r = checkCitations('公司经营正常。', ['ref_1']);
    expect(r.cited).toEqual([]);
    expect(r.hasAny).toBe(false);
  });

  it('不接受集合外的近似写法（大小写、无前缀都不算命中）', () => {
    const text = 'A[^ref_1] B[^REF_1] C[^1]';
    const r = checkCitations(text, ['ref_1']);
    // [^REF_1] 与 [^1] 都不匹配 ref_ 前缀规范 → 不被当作角标，计入 cited 之外
    expect(r.cited).toEqual(['ref_1']);
    expect(r.invalid).toEqual([]);
  });
});
