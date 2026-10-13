import { describe, it, expect } from 'vitest';
import { parseInlineMarkdown, parseBodyLines } from './markdown';

/**
 * Seam 15: 正文内联 Markdown 解析
 *
 * 背景（真机输出暴露）：模型的真实正文含 Markdown —— 加粗 `**客户订单**`、
 * 无序列表 `- `。而三栏证据区用 `whitespace-pre-wrap` 直接渲染纯文本，
 * 于是用户在页面上看到的是**字面星号** `**并无经历任何客户订单…**`。
 * 这是演示路径上的可见缺陷，不是吹毛求疵。
 *
 * 设计边界（重要）：**只支持模型实际会写的极小子集** —— 加粗与列表项。
 * 不做完整的 Markdown 渲染（不引入依赖、不支持链接/表格/嵌套），
 * 因为过度解析反而会误伤金融文本里的普通符号（如 `*` 用于脚注、`_` 用于代码）。
 *
 * 抓到：字面星号外露、列表项未缩进、普通星号被误当加粗。
 * 漏掉：复杂嵌套语法（明确不支持）。
 *
 * 关键红线：**不得丢字**。任何解析路径下，把所有文本片段拼起来必须与
 * 去掉标记符号后的原意一致（断言覆盖）。
 */

describe('parseInlineMarkdown', () => {
  it('把 **加粗** 切成 bold 片段', () => {
    const t = parseInlineMarkdown('公司**并无经历任何客户订单**变化');
    expect(t).toEqual([
      { type: 'text', value: '公司' },
      { type: 'bold', value: '并无经历任何客户订单' },
      { type: 'text', value: '变化' },
    ]);
  });

  it('加粗标记本身不出现在任何片段里（不再外露星号）', () => {
    const t = parseInlineMarkdown('**A**与**B**');
    const joined = t.map((x) => x.value).join('');
    expect(joined).toBe('A与B');
    expect(joined).not.toContain('*');
  });

  it('单个星号（如脚注/乘号语境）不被当作加粗，原样保留', () => {
    const t = parseInlineMarkdown('营收增长 3*5 个百分点');
    expect(t).toEqual([{ type: 'text', value: '营收增长 3*5 个百分点' }]);
  });

  it('未闭合的 ** 原样保留（宁可显示标记，也不吞掉内容）', () => {
    const t = parseInlineMarkdown('**未闭合的加粗');
    expect(t.map((x) => x.value).join('')).toContain('**未闭合的加粗');
  });

  it('空字符串返回空数组', () => {
    expect(parseInlineMarkdown('')).toEqual([]);
  });

  it('无任何标记时返回单段文本', () => {
    expect(parseInlineMarkdown('普通正文')).toEqual([{ type: 'text', value: '普通正文' }]);
  });

  it('不丢字：拼接结果等于去掉 ** 标记后的原文', () => {
    const src = '**A**普通**B**尾';
    const joined = parseInlineMarkdown(src).map((x) => x.value).join('');
    expect(joined).toBe('A普通B尾');
  });

  it('连续多个加粗片段都能解析', () => {
    const t = parseInlineMarkdown('**A****B**');
    expect(t.filter((x) => x.type === 'bold').map((x) => x.value)).toEqual(['A', 'B']);
  });

  it('确定性：同输入同输出', () => {
    expect(parseInlineMarkdown('**x**y')).toEqual(parseInlineMarkdown('**x**y'));
  });
});

describe('parseBodyLines（列表与段落）', () => {
  it('识别行首列表项，去掉 "- " 标记', () => {
    const lines = parseBodyLines('- 第一项\n- 第二项');
    expect(lines.map((l) => l.type)).toEqual(['li', 'li']);
    expect(lines[0].token.map((t) => t.value).join('')).toBe('第一项');
  });

  it('普通段落标为 p', () => {
    const lines = parseBodyLines('这是一段话。');
    expect(lines[0].type).toBe('p');
  });

  it('跳过空行（不产生空段落）', () => {
    expect(parseBodyLines('A\n\n\nB').map((l) => l.type)).toEqual(['p', 'p']);
  });

  it('列表项内的加粗也解析', () => {
    const lines = parseBodyLines('- **重点**说明');
    expect(lines[0].token).toEqual([
      { type: 'bold', value: '重点' },
      { type: 'text', value: '说明' },
    ]);
  });

  it('支持 • 作为列表标记', () => {
    expect(parseBodyLines('• 项目')[0].type).toBe('li');
  });

  it('不丢字：所有行文本拼接后包含原意', () => {
    const src = '- **A**项\n正文B';
    const all = parseBodyLines(src).flatMap((l) => l.token).map((t) => t.value).join('');
    expect(all).toBe('A项正文B');
  });

  it('空输入返回空数组', () => {
    expect(parseBodyLines('')).toEqual([]);
  });
});
