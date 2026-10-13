/**
 * Seam 16: 标签微调后的重跑文本（spec 交互决策的下游）
 *
 * 设计要点：
 * - 从 `app/page.tsx` 抽出的纯函数：页面只负责"何时调用"，这里负责"说什么"。
 *   理由与其它 seam 一致 —— 有规则的部分必须可精确单测，而不是埋在 JSX 里。
 * - **必须带住原命题**：下一轮的命题重构依赖它定位标的与语境。
 *   不带原命题的话，"删除一个标签重新分析"实际会退化成"换个话题重新开始"。
 * - 区分"删除"与"编辑确认"两种意图（用户的动作语义不同，模型被告知的信息也应不同）。
 * - 措辞为核验向，不含买卖操作词 —— 否则重跑会先被合规层拦下。
 */

export interface RerunInput {
  reason: 'delete' | 'edit-confirmed';
  /** 删除时是被删标签；编辑时是改后的标签。 */
  tag: string;
  /** 变更后的完整标签集合。 */
  nextTags: string[];
  /** 本轮已确认的命题（用于带住语境）；可为空。 */
  base: string;
}

/**
 * 构造重跑提问。
 *
 * 空 base / 空 nextTags 时不留下 "原命题：" 这类悬空片段 —— 残缺指令会让
 * 模型在下一轮自由发挥，等于绕过了标签微调的意图。
 */
export function buildRerunText(input: RerunInput): string {
  const tags = input.nextTags.filter((t) => t.trim() !== '');
  const tagsPart = tags.length > 0 ? `：${tags.join('；')}` : '（无标签）';

  const head =
    input.reason === 'delete'
      ? `请按以下意图标签重新核验（已删除「${input.tag}」）${tagsPart}`
      : `请按修改后的意图标签重新核验${tagsPart}`;

  const base = input.base.trim();
  return base === '' ? `${head}。` : `${head}。原命题：${base}`;
}
