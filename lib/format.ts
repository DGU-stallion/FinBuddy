/**
 * Seam 11: 网关载荷 -> LLM 上下文文本
 *
 * 设计要点（见 ADR-0001 / ADR-0002）：
 * - 来源、时点、单位、refId 必须出现在文本里，让模型无法"忘记"标注出处。
 * - 缺失字段必须显式写"缺失"，不得静默省略（题目红线）。
 * - 降级数据必须带显著过期警告，防止模型当作实时数据正常陈述。
 */

export interface SnapshotPayload {
  refId: string;
  source: string;
  asOf: number;
  isFallback: boolean;
  fallbackNote?: string;
  data: {
    thscode?: string;
    name?: string;
    last_price?: number;
    price_change_ratio_pct?: number;
    turnover?: number;
    pe_ttm?: number;
    pb_mrq?: number;
  };
}

export interface FinancialsPayload {
  refId: string;
  source: string;
  asOf: number;
  isFallback: boolean;
  /** L2 降级时的抓取说明（与 SnapshotPayload 对称）。 */
  fallbackNote?: string;
  data: {
    thscode?: string;
    report?: string;
    baseRevenue?: number;
    revenueBasis?: string;
    netMargin?: number;
    grossMargin?: number;
    taxRate?: number;
  };
}

/** 类型谓词：为 true 时收窄为 undefined，让后续代码可以安全使用数值。 */
function isMissing(v: number | undefined | null): v is undefined | null {
  return v === undefined || v === null || Number.isNaN(v);
}

function fmtDate(ms: number): string {
  if (!ms || Number.isNaN(ms)) return '时点缺失';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatSnapshotForLLM(p: SnapshotPayload): string {
  const d = p.data;
  const lines: string[] = [];
  lines.push(`【行情快照 · 引用号 ${p.refId}】`);
  lines.push(`数据来源：${p.source}`);
  lines.push(`数据时点：${fmtDate(p.asOf)}`);
  if (p.isFallback) {
    lines.push(`⚠️ 降级存证：外部实时接口不可用，当前为历史存证数据${p.fallbackNote ? `（${p.fallbackNote}）` : ''}，非实时行情。`);
  }
  lines.push(`标的：${d.thscode ?? '缺失'}${d.name ? ` ${d.name}` : ''}`);
  lines.push(`最新价：${isMissing(d.last_price) ? '缺失' : `${d.last_price} 元`}`);
  lines.push(
    `涨跌幅：${isMissing(d.price_change_ratio_pct) ? '缺失' : `${d.price_change_ratio_pct.toFixed(2)}%`}`,
  );
  lines.push(`成交额：${isMissing(d.turnover) ? '缺失' : toYi(d.turnover)}`);
  lines.push(`PE(TTM)：${isMissing(d.pe_ttm) ? '缺失' : d.pe_ttm.toFixed(2)}`);
  lines.push(`PB(MRQ)：${isMissing(d.pb_mrq) ? '缺失' : d.pb_mrq.toFixed(2)}`);
  return lines.join('\n');
}

export function formatFinancialsForLLM(p: FinancialsPayload): string {
  const d = p.data;
  const lines: string[] = [];
  lines.push(`【财务参数 · 引用号 ${p.refId}】`);
  lines.push(`数据来源：${p.source}`);
  lines.push(`数据时点：${fmtDate(p.asOf)}`);
  if (p.isFallback) {
    lines.push(
      `⚠️ 降级存证：外部实时接口不可用，当前为历史存证数据，非最新报告期${
        p.fallbackNote ? `（${p.fallbackNote}）` : ''
      }。`,
    );
  }
  lines.push(`报告期：${d.report ?? '缺失'}`);
  lines.push(
    `基准营收（${d.revenueBasis ?? '口径未标注'}）：${isMissing(d.baseRevenue) ? '缺失' : toYi(d.baseRevenue)}`,
  );
  lines.push(`净利率：${isMissing(d.netMargin) ? '缺失' : `${d.netMargin.toFixed(2)}%`}`);
  lines.push(`毛利率：${isMissing(d.grossMargin) ? '缺失' : `${d.grossMargin.toFixed(2)}%`}`);
  // 标注来源："有效所得税率"是**推导值**（Σ所得税费用 ÷ Σ税前利润），不是接口直出字段。
  // 这里必须与 UI（lib/evidence.ts 抽屉、SensitivityCard 测算卡片）口径一致 ——
  // 否则模型会转述成"据财报，所得税率为 14.84%"，绕过 UI 层的诚实标注。
  // （Standard 轴评审指出：标注做了三层，唯独漏了决定模型怎么说的最上游一层。）
  lines.push(
    `有效所得税率（推导：Σ所得税费用 ÷ Σ税前利润）：${
      isMissing(d.taxRate) ? '缺失' : `${d.taxRate.toFixed(2)}%`
    }`,
  );
  return lines.join('\n');
}

// ---------- 共享格式化助手（单一事实来源，避免多处重复实现分叉） ----------

/**
 * UTC 纯日期 `YYYY-MM-DD`。
 *
 * 为什么统一到 UTC（Standard 轴评审 #5）：本函数此前在 lib/evidence.ts、
 * lib/sensitivity.ts、lib/output-contract.ts 各有一份**逐字重复**实现。
 * 重复实现会静默分叉（任一处改精度/时区，其余不变），故收敛到此处导出。
 *
 * 用 UTC 而非本地时区：存证时点的展示与契约校验必须与运行机器的时区无关，
 * 否则同一份 payload 在不同时区看到不同日期，校验结果也会漂移。
 * （注意 lib/format.ts 里的 fmtDate 带时分、用本地时区，用于 LLM 上下文，
 *  语义不同，保留。）
 */
export function utcDate(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '时点缺失';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 亿元换算，两位小数（共享单一事实来源）。
 *
 * 此前有 4 份重复实现（lib/format.ts、lib/evidence.ts、lib/context-summary.ts、
 * components/SensitivityCard.tsx），其中 evidence.ts 的注释还自称"与 format 同口径"
 * —— 用注释代偿重复，未来改精度就会静默分叉（Standard 轴评审 #6）。
 */
export const toYi = (v: number): string => `${(v / 1e8).toFixed(2)} 亿元`;
