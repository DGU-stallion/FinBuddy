/**
 * L2 本地预置存证（ADR-0001 决策 3）
 *
 * 用途：L1 实时接口失败时的保底，让预置演示案例在断网时仍能走完整链路。
 * 边界：仅覆盖预置案例（中际旭创 / 宁德时代）；自由查询不走 L2，直接进入 L3 信息真空期。
 * 铁律：必须显著标注抓取日期与"非实时数据"，绝不冒充实时行情。
 *
 * 数据来源：2026-10-12 真机抓取自扶摇 MCP（未经任何人工修改）。
 */

import type { SnapshotPayload } from './format';

export interface FallbackRecord {
  thscode: string;
  name: string;
  asOf: number;
  note: string;
  source: string;
  snapshot: SnapshotPayload['data'];
}

const CAPTURED_AT = Date.UTC(2026, 9, 12, 15, 45); // 2026-10-12 抓取
const CAPTURE_NOTE = '抓取于 2026-10-12，非实时行情';

const RECORDS: FallbackRecord[] = [
  {
    thscode: '300308.SZ',
    name: '中际旭创',
    asOf: CAPTURED_AT,
    note: CAPTURE_NOTE,
    source: 'L2 本地存证 · 扶摇历史快照',
    snapshot: {
      thscode: '300308.SZ',
      name: '中际旭创',
      last_price: 724.47,
      price_change_ratio_pct: -6.411316,
      turnover: 15623739000,
      pe_ttm: 41.722396,
      pb_mrq: 21.409387,
    },
  },
  {
    thscode: '300750.SZ',
    name: '宁德时代',
    asOf: CAPTURED_AT,
    note: CAPTURE_NOTE,
    source: 'L2 本地存证 · 扶摇历史快照',
    snapshot: {
      thscode: '300750.SZ',
      name: '宁德时代',
      last_price: 298.38,
      price_change_ratio_pct: 0.211587,
      turnover: 12580165600,
      pe_ttm: 16.243252,
      pb_mrq: 3.639555,
    },
  },
];

export function getFallbackSnapshot(thscode: string): FallbackRecord | null {
  const key = thscode.trim().toUpperCase();
  return RECORDS.find((r) => r.thscode === key) ?? null;
}

export function listFallbackCases(): FallbackRecord[] {
  return RECORDS;
}
