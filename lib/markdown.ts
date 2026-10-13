/**
 * Seam 15: 正文内联 Markdown 解析（模型真实输出含 Markdown）
 *
 * 设计要点：
 * - 真机输出暴露的缺陷：模型正文含 `**加粗**`，而三栏区按纯文本渲染，
 *   用户在页面上看到字面星号 `**并无经历任何客户订单**`。这属于演示路径上的
 *   可见缺陷，必须处理。
 * - **只支持模型实际会写的极小子集**：`**加粗**`。不做完整 Markdown ——
 *   金融文本里 `*`、`_`、`#` 有正常用法（脚注、代码、编号），
 *   过度解析会误伤真实内容。列表 `- ` 由调用方按行处理（见 splitLines）。
 * - **绝不丢字**：解析失败（未闭合）时原样保留标记，宁可显示 `**`
 *   也不吞掉内容。这是金融文本渲染的底线。
 * - 纯函数、无依赖：不引入 Markdown 库（体积与攻击面都不值得）。
 */

export type InlineToken = { type: 'text' | 'bold'; value: string };

/** 匹配 `**非空内容**`；不允许换行跨越（避免把两段话连成一个加粗块）。 */
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

/**
 * 把一行文本切成 text/bold 片段。
 *
 * 未闭合的 `**` 不会被匹配（正则要求成对），因此会原样留在 text 片段里 ——
 * 这是刻意的"宁可显示标记，也不吞内容"。
 */
export function parseInlineMarkdown(text: string): InlineToken[] {
  if (typeof text !== 'string' || text === '') return [];

  const tokens: InlineToken[] = [];
  let last = 0;

  // 重置 lastIndex：BOLD_RE 是模块级带 g 的正则，跨调用会残留状态。
  BOLD_RE.lastIndex = 0;
  for (const m of text.matchAll(BOLD_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ type: 'text', value: text.slice(last, idx) });
    tokens.push({ type: 'bold', value: m[1] });
    last = idx + m[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });

  return tokens.filter((t) => t.value !== '');
}

/** 行类型：列表项 或 普通段落。 */
export interface LineToken {
  type: 'li' | 'p';
  token: InlineToken[];
}

/**
 * 把多行正文切成「列表项 / 段落」序列（供三栏渲染，避免把 `- ` 原样显示）。
 *
 * 只识别行首 `- ` / `• `，不处理嵌套列表（模型输出里未出现，且嵌套需要
 * 更完整的解析器 —— 不做不在需求内的复杂度）。
 */
export function parseBodyLines(text: string): LineToken[] {
  const out: LineToken[] = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    const li = line.match(/^\s*[-•]\s+(.*)$/);
    out.push({ type: li ? 'li' : 'p', token: parseInlineMarkdown(li ? li[1] : line) });
  }
  return out;
}
