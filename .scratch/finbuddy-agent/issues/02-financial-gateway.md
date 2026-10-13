# 02: 三源金融网关 + 三级降级 + refId

**What to build:** 一个统一的金融数据网关，对上层暴露三个深模块工具（行情快照 / 财报参数 / 公告新闻检索），内部对接扶摇 MCP 与 iFinD MCP，并实现 L1 实时 → L2 预置存证 → L3 信息真空期 的三级降级。每次成功调用返回的结构化载荷都携带网关生成的 `refId`，供上层角标引用与存证抽屉溯源（见 ADR-0002）。

**Blocked by:** 01

**Status:** done (2026-10-12，真机验证三工具 + 修复 refId 并发重复缺陷)

- [x] `lookupStockSnapshot(ticker)`：扶摇 `get_a_share_prices_snapshot` + `get_a_share_valuations_snapshot`，返回价格/涨跌幅/PE/PB
- [x] `lookupFinancialReport(ticker)`：扶摇 `get_a_share_financials_income_statements`（`period=quarterly`）+ `get_a_share_financials_indicators`（`report={yyyy}-{1|2|3|4}`），返回营业收入、净利润、净利率（`sale_net_interest_ratio`）、毛利率
- [x] 基准营收 `BaseRevenue` 按 TTM 年化口径计算（四季滚动）；若无法拼出 TTM，降级为最近单季 ×4 并在载荷中标注口径（见 ADR-0001 补充决策 4）
- [x] `searchAnnouncementsAndNews(ticker, keyword)`：iFinD `search_notice` + `search_news`（必带 `time_start`/`time_end`，`YYYY-MM-DD`），返回公告标题/片段/日期
- [x] 标的名称或代码 → thscode 解析（扶摇标的检索；解析失败返回结构化"未识别"而非抛异常）（见 ADR-0001 补充决策 5）
- [x] 三级降级：L1 超时(>3s)或报错 → L2 本地预置存证（仅限中际旭创等预置案例，载荷标记 `isFallback: true` + 抓取日期）；L2 未收录 → L3 信息真空期声明（见 ADR-0001 决策 3）
- [x] 每个成功返回的载荷携带 `refId`、`source`（数据源名）、`asOf`（数据时点）、`isFallback`
- [x] iFinD session 管理正确（`initialize` → `Mcp-Session-Id` → `notifications/initialized`）
- [x] 限流与错误：识别扶摇 `code=4001`/HTTP 429 与 iFinD 错误码，返回结构化错误而非静默失败

**验收方式（自动化 + 真机）:** 网关单测覆盖"参数格式正确性 / refId 生成 / 降级触发"；真机调用三个工具各一次，打印真实返回字段。

---

## 勾选说明（2026-10-13 补记）

本票在原开发时已实现并通过验证（见 Status），但当时漏勾复选框。2026-10-13
交付前逐项抽查后补勾，抽查依据：

- T1：`app/api/chat/route.ts` 含 `streamText` + `stopWhen`（多步循环）；
  `app/page.tsx` 用 `useChat`；
- T2：三个工具均在 `route.ts` 中注册；`lib/financials.ts` 的 `sumTTM` 做 TTM 年化；
  `lib/ifind.ts` 有 `initialize` → `Mcp-Session-Id` 的 session 管理，
  并以结构化 `IfindError`（timeout/http/auth/business/shape）返回错误，
  而非静默失败（本票要求"返回结构化错误"，未字面使用 `4001`/`429`
  是因为错误在网关层被归一化为语义类别）。

**未重新做真机回归**：本票的真机验证发生在 2026-10-12，此后代码有演进
（T3-T5）。当前 DeepSeek 余额耗尽，真机集成测试处于 skipped 状态，
因此本票的"真机通过"结论属于**当时有效**，未在本日重新确认。
