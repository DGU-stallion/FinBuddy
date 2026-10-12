/**
 * Seam 6: 核验向追问过滤（ADR-0002 补充决策 5）
 *
 * 设计要点：
 * - 追问由模型生成（保证"逻辑递进"，不用死模板），但必须过确定性过滤。
 * - 过滤是白名单 + 黑名单双判：含操作/预测语言即淘汰；且必须含核验标记。
 *   只看黑名单会放过"这只股票怎么样"这类空泛问题，只看白名单会放过
 *   "要不要买入毛利率高的股票"这类伪装成核验向的操作问题。
 * - 数量恒为 3（票面要求）：不足时用确定性兜底补齐，而不是少给。
 */

export const FOLLOWUP_COUNT = 3;

/** 操作向/预测向：索取自身买卖决策或预测股价的语言。 */
const OPERATIONAL_PATTERNS: RegExp[] = [
  /该不该|要不要|能不能|可不可以/,
  /建议(买入|卖出|加仓|减仓|建仓|清仓)/,
  /(买入|卖出|加仓|减仓|建仓|清仓|满仓|杠杆|抄底|割肉|梭哈|上车|下车|持有|拿住)/,
  /目标价/,
  /(会|将|要|即将|马上|一定)涨/,
  /(会|将|要|即将|马上|一定)跌/,
  /涨停|跌停/,
  /稳赚不赔|保本|翻倍|必涨|必跌/,
];

/** 核验向标记：证伪 / 下钻 / 对比 三类，与票面例子对齐。 */
const VERIFICATION_MARKERS = [
  '能否',
  '是否',
  '有没有',
  '多少',
  '几个季度',
  '对比',
  '同行',
  '竞品',
  '毛利率',
  '净利率',
  '营收',
  '净利润',
  '公告',
  '披露',
  '口径',
  '现金流',
  '存货',
  '应收',
  '订单',
  '信息真空期',
];

/** 单条追问是否为核验向：不含操作/预测语言，且含核验标记。 */
export function isVerificationOriented(question: string): boolean {
  const q = question.trim();
  if (q === '') return false;
  if (OPERATIONAL_PATTERNS.some((re) => re.test(q))) return false;
  return VERIFICATION_MARKERS.some((m) => q.includes(m));
}

export interface SanitizeOptions {
  /** 追问主语（标的名或"该公司"），用于兜底补齐。 */
  subject?: string;
}

/** 确定性兜底追问（核验向，无操作语言），保证数量恒为 3。 */
function fallbackQuestion(i: number, subject: string): string {
  const pool = [
    `${subject}最近报告期的营收与净利率是否足以支撑当前估值？`,
    `${subject}的官方公告中有无与本次传闻直接相关的披露？`,
    `同行竞品的毛利率口径与${subject}相比有何差异？`,
  ];
  return pool[i % pool.length];
}

/**
 * 过滤、去重并补齐追问。
 *
 * @returns 恰好 FOLLOWUP_COUNT 条核验向追问（顺序保持模型给出的递进顺序）。
 */
export function sanitizeFollowUps(raw: unknown, options: SanitizeOptions = {}): string[] {
  const subject = options.subject?.trim() || '该公司';

  const candidates = Array.isArray(raw)
    ? raw.filter((q): q is string => typeof q === 'string').map((q) => q.trim())
    : [];

  const kept: string[] = [];
  for (const q of candidates) {
    if (kept.length >= FOLLOWUP_COUNT) break;
    if (!isVerificationOriented(q)) continue;
    if (kept.includes(q)) continue;
    kept.push(q);
  }

  // 兜底补齐：数量契约优先于"宁缺毋滥"（票面要求恒为 3 个）
  let i = 0;
  let guard = 0;
  while (kept.length < FOLLOWUP_COUNT && guard < FOLLOWUP_COUNT * 2) {
    const fb = fallbackQuestion(i, subject);
    if (!kept.includes(fb)) kept.push(fb);
    i += 1;
    guard += 1;
  }

  return kept;
}
