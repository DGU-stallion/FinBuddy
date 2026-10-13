# FinBuddy 前端 UI 重做调研 —— 同花顺问财风格对话式界面

> 调研日期：2026-10-13 · 调研方式：直接抓取 iwencai.com 页面 / CSS / JS bundle 提取 design token（实证）+ 公开文章与行业惯例（推断）
> 标注约定：**[实证]** = 真在页面资源里看到/抓到；**[推断]** = 行业惯例或二手来源，未在同花顺官方资源中验证。

---

## 1. 同花顺问财界面实录

### 1.1 布局结构（实证，来自 https://www.iwencai.com/ 首页抓取 2026-10-13）

- **形态：单页对话入口**。首页中心就是一个大输入框（"输入条件，多维筛选，精准捕捉"），下方不是结果列表而是**推荐内容流**：热门题材（电力/PCB/白酒…带一句话解读）、示例提问（"超跌股且W底""kdj金叉，macd金叉的股票"）、策略卡片（"高现金高毛利战法"：年化收益 +34.95% / 累计收益 +917.58% / 最大回撤 55.24%，三指标横排）。
- **多市场 tab**：A股 / 港股 / 美股 / 可转债 / 基金 / 保险 / 期货 / 宏观 / 外汇，每个市场下挂示例 query。
- **对话页**：SPA（Vue），独立 chunk `vendor-chatui-*.js`（1.6MB），说明对话界面是独立组件库。token 里有 `--chat-left-bubble-bg-color`（AI 回复，白底 `#fff`）和 `--chat-right-bubble-bg-color`（用户提问，浅蓝 `#d3e0ff`）——**问财对话页是气泡式**，用户右气泡浅蓝底，AI 左气泡白底。
- **结果呈现**：问财大模型官方宣传有 **14 种数据可视化组件**（动态折线图、动态双柱图等）+ 表格 [来源](https://www.aihub.cn/tools/trading/iwencai)。典型路径是「自然语言 → 解析条件 → 结构化表格 + 图表」，表格可增删列。
- 策略卡片信息组织：头像/名称/标签（基本面·中长线·价值投资）+ 三个核心指标横排（年化收益红字、累计收益红字、最大回撤黑字）。
- 页脚标注「内容由AI生成，请仔细甄别」——合规免责声明常驻，**我们的核验助手也应保留类似免责条**。

### 1.2 配色（实证：从 `vendor-chatui-ff6cf4a9.js` 与 `index-*.css` 中直接提取的 CSS 变量）

**问财 web 对话页主色调其实是"蓝 + 白底浅色"，品牌红只作点缀** —— 这是最重要的反直觉发现：

| 用途 | token | 色值 | 标注 |
|---|---|---|---|
| 品牌主色（链接/强调/激活态） | `--brand-text-color` / `--blue-color1` | `#165dff` / `#136dff` | 实证（Arco 风格蓝） |
| 聊天强调蓝 | `--chat-brand-text-color` / `--chat-color-brand-blue1` | `#1678FF` | 实证 |
| 品牌浅底 | `--brand-bg` | `#f0f4ff` | 实证 |
| 用户气泡底 | `--bubble-question-bg` / `--chat-right-bubble-bg-color` | `#d3e0ff` | 实证 |
| AI 气泡底 | `--bubble-answer-bg` / `--chat-left-bubble-bg-color` | `#ffffff` | 实证 |
| 页面背景 | `--bg-color1` / `--bg-color3` | `#f4f4f5` / `#fafafa` | 实证（浅灰白，非深色） |
| 一级文字 | `--text-color1` / `--chat-text-color1` | `#10131f` / `#262626` | 实证 |
| 二级文字 | `--text-color2` / `--chat-text-color2` | `#5e606a` / `#595959` | 实证 |
| 三级/辅助文字 | `--text-color3` / `--chat-text-color3` | `#8f9198` / `#b3b3b3` | 实证 |
| 边框 | `--border-color1` / `--divide-line` | `#eaeaeb` / `#ebebeb` | 实证 |
| 品牌红（勾选/高亮边框） | `--chat-checkbox-checked-icon-color`、index.css 徽标 | `#e93030`，渐变 `#f5605b→#e93030` | 实证（红色仅小面积：角标、勾选、高亮） |
| 语义红（涨/错误确认） | `--chat-color-brand-red1` / `--chat-dialog-confirm-font-color` | `#FF2346` / `#EF3B3B` | 实证 |
| 语义蓝紫（高级模式） | `--chat-agent-mode-*` | `#1678FF` / `#381982` | 实证 |
| 黄（警示/数据强调） | `--chat-color-brand-yellow1`、index.css | `#F29E3C` / `#e8a600` | 实证 |
| 绿色（diff 增/涨反义） | `--chat-code-diff-added-line-number` | `#52af89` | 实证（非涨跌专用，涨跌语义色未在静态资源中找到，标注为查不到） |

> ⚠️ A股「红涨绿跌」的涨跌专用色在抓到的静态资源里没有明确的 token（动态行情组件懒加载）。同花顺 App 内红涨绿跌为默认、可在设置切换（[百度经验](https://jingyan.baidu.com/article/6c67b1d6ebb8df6686bb1ed0.html)）。**建议涨跌色值用推断值：涨 `#e54545`~`#f5222d`、跌 `#1faa59`~`#2e9e5b`（推断，非实证）。**

### 1.3 字体与字号（实证，index-*.css 统计）

- 字号频次：**14px（45 处）> 12px（33）> 16px（20）> 20px（4）> 28px（3）** > 13/15/18px 零星。即正文 14、辅助 12、标题 16/20，符合金融产品高密度惯例。
- 字体栈：`Arial, PingFangSC-Regular, Microsoft YaHei, Helvetica, Simsun, sans-serif`；数字有专用字体 `THSMoneyfont-Medium` / `THSMoneyFont`（同花顺自研数字字体，等宽、tabular-nums）。
- 圆角：4px（23 处）> 8px（16）> 6px / 10px > 12px，弹窗 16px、气泡 22/24px。**小圆角为主**。
- 弹窗：`border-radius:16px; padding:8px 24px 16px; box-shadow:0 8px 32px`。

### 1.4 结果卡片信息组织（实证 + 推断）

- 策略卡：名称 + 标签 chip + 三指标横排，红字强调收益、黑/灰字显示回撤 —— 即「**标题 / 标签 / 核心指标带**」三段式。
- 选股结果：表格化（列可配），新闻类结果为「题材名 + 一句话摘要 + 日期」列表项。
- AI 回答内嵌 14 种图表组件，表格与图表混排在对话流中（推断：官方宣传，未能登录看到实际对话结果页）。

---

## 2. 同花顺设计语言要点 → Tailwind token

核心结论：**问财 web 端是浅色底 + 蓝主色 + 红色点睛，不是"全红"，更不是深色。** 同花顺 App/PC 客户端的经典皮肤才是深色+红绿行情；web 新一代 AI 产品（问财）已向 ChatGPT 式浅底对话靠拢，品牌识别靠：红色角标/徽标、红涨绿跌的数据着色、自研数字字体、高密度排版。

```ts
// tailwind.config.ts（值均为实证，除标注外）
export default {
  theme: {
    extend: {
      colors: {
        brand:  { DEFAULT: '#165dff', hover: '#136dff', bg: '#f0f4ff' },
        chat:   { blue: '#1678FF', bubbleUser: '#d3e0ff', bubbleAi: '#ffffff' },
        ink:    { 1: '#10131f', 2: '#5e606a', 3: '#8f9198', 4: '#c1c2c6' },
        line:   { DEFAULT: '#eaeaeb', strong: '#dddde0' },
        page:   { DEFAULT: '#f4f4f5', alt: '#fafafa' },
        rise:   '#e93030',   // 涨 / 品牌红（实证色，用于涨跌属推断用法）
        fall:   '#1faa59',   // 跌（推断，未在官方资源中验证）
        warn:   '#e8a600',
      },
      fontSize: {
        aux:  ['12px', '16px'],
        body: ['14px', '22px'],
        card: ['16px', '24px'],
        kpi:  ['20px', '28px'],
        hero: ['28px', '36px'],
      },
      borderRadius: { card: '8px', chip: '4px', bubble: '12px', modal: '16px' },
      fontFamily: {
        num: ['"DIN Alternate"', 'Arial', 'sans-serif'], // 替代 THSMoneyFont，配合 font-variant-numeric: tabular-nums
      },
    },
  },
}
```

排版规则（推断自频次统计 + 金融惯例）：
- 数字一律 `tabular-nums`；涨跌数字带符号 `+/-` 并着红/绿。
- 卡片内边距 12–16px；列表项高 44px 左右；表格行高 36–40px。
- 信息密度：同屏尽量多给数据，但用 12px 辅助色做"次级信息降噪"。

---

## 3. 对话式 + 结构化数据的布局方案（候选与取舍）

### 方案 A：全宽消息流（推荐）—— Claude/ChatGPT 式 + 问财卡片
- 用户提问：右对齐小气泡（`#d3e0ff`）；AI 回答：**不用气泡**，全宽区块，内部自由排版（结论文本 + 核验卡片 + 对比表格 + 时间轴）。
- 优点：表格/三栏对比不受气泡宽度限制；Setproduct 调研明确指出全宽是严肃 AI 工具的最佳实践，气泡= messenger 感会削弱工具属性（[来源](https://www.setproduct.com/blog/ai-chat-interface-ui-design)）。
- 缺点：实现比纯气泡略复杂；需要用留白/分隔线代替气泡边界。

### 方案 B：混合式 —— 文本气泡 + 数据卡片
- 短文本进气泡；凡含 ≥2 指标 / 表格 / 对比的内容渲染为**独立卡片**（白底、8px 圆角、1px `#eaeaeb` 边框），挂在气泡下方。问财即此模式。
- 优点：对话感强；与问财实拍一致；对 hackathon 演示友好（卡片视觉锤强）。
- 缺点：长短不一的消息边界略乱。

### 方案 C：左对话右画布（Canvas）—— 核验工作台
- 左侧 360–420px 对话流，右侧画布渲染当前命题的核验报告（三栏：支持证据 / 反驳证据 / 数据表）。
- 优点：最贴"投资命题核验"的工具属性；复杂对比展示最好。
- 缺点：24h 内两套布局成本高；与"朝问财靠拢"的诉求偏离（问财是单栏）。

**建议：主选 B（混合式），把"三栏对比"做成对话流里的一张宽卡片；时间充裕再把该卡片支持"展开为右侧抽屉"。**

### 流式过程展示（业界共识，[Setproduct agent patterns](https://www.setproduct.com/blog/ai-agent-ui-design-patterns)）
- 竖向步骤列表：pending 空心圈 / running 旋转 / done ✓ / failed ✗；步骤可折叠，展开看工具调用细节；正在运行的步骤钉在视口内。
- 推理文本默认折叠成一行 "Thinking…"；**工具调用渲染为卡片，推理渲染为折叠区**——改变了世界的给卡片，只改变了想法的给折叠。
- 事件协议参考 AG-UI：`RUN_STARTED / STEP_STARTED / STEP_FINISHED / RUN_FINISHED`（[Codecademy](https://www.codecademy.com/article/ag-ui-agent-user-interaction-protocol)）。

---

## 4. 反例与坑

1. **气泡里塞大表格**：聊天气泡通常 max-width 60–75%，12 列表格在里面必然横向滚动+字号压到 10px，不可读。→ 数据一律出气泡进卡片。
2. **深色底 + 红绿涨跌**：深色 slate 上红绿饱和度必须拉高才可见，结果就是"霓虹赌场风"。同花顺新一代 web 已全面浅色化；A股用户并不拒绝浅色，拒绝的是看不出涨跌。
3. **颜色泛滥**：实证显示问财红 `#e93030` 只出现在角标/勾选/高亮边——**品牌色做小面积点缀，涨跌语义色才大面积出现在数字上**。把整个页面染红是山寨炒股软件感。
4. **流式时只显示转圈**：agent 任务 40s 无可见进度，用户会刷新重发（Setproduct 明确指出）。必须有步骤时间轴。
5. **字号一刀切**：金融界面的可读性靠「14 正文 / 12 辅助 / 20+ 关键数字」的层级，不是全局放大。
6. **把推理过程全部平铺**：长篇 reasoning 内联会淹没结论。默认折叠。
7. **伪造精度**：核验助手展示指标时标明数据来源与时间，别让 AI 生成的数字看起来像实时行情（合规与信任双重要求，问财页脚常驻"内容由AI生成，请仔细甄别"）。
8. **涨跌色不可换**：A股红涨绿跌是肌肉记忆，不要做成可配置之外的任何变体；同时注意色觉障碍用户（同花顺 App 有专门的红绿切换设置）。

---

## 5. 参考素材清单

- [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) — React AI 对话组件库（12.4k★），支持工具调用渲染为 React 组件、流式、LangGraph/AI SDK 适配；24h hackathon 最快起点。
- [Vercel AI Chatbot](https://github.com/vercel/ai-chatbot) — Next.js + shadcn + AI SDK 官方模板，消息流/卡片渲染可参考。
- [Setproduct: AI chat interface anatomy](https://www.setproduct.com/blog/ai-chat-interface-ui-design) — 全宽 vs 气泡的取舍依据。
- [Setproduct: 16 AI agent UI patterns](https://www.setproduct.com/blog/ai-agent-ui-design-patterns) — 步骤时间轴/思考折叠/暂停修订的具体模式。
- [AG-UI 协议解析](https://www.codecademy.com/article/ag-ui-agent-user-interaction-protocol) — 流式事件到 UI 的映射模型。
- [shadcn/ui 官方 examples](https://ui.shadcn.com/examples/dashboard) — Card / Table / Badge 基础件；金融密度自行加 `text-[13px] leading-5`、`px-3 py-2`。
- [TanStack Table](https://tanstack.com/table) — 高密度数据表格事实标准（排序/列显隐/虚拟滚动），比手写 table 快。
- [IBM Carbon Chatbot pattern](https://v10.carbondesignsystem.com/community/patterns/chatbot/usage) — 「Card with data (Table/Visualization)」作为对话内数据组件的分类法。
- [AIHub 问财大模型介绍](https://www.aihub.cn/tools/trading/iwencai) — 问财 14 种可视化组件的官方描述（佐证表格+图表混排）。
- [优设：同花顺自选模块优化](https://www.uisdc.com/redesign-your-edge) — 同花顺信息密度与卡片化的二手设计分析（推断来源）。

## 6. 给实现者的具体建议

1. **整体**：浅色底 `#f4f4f5`，卡片白底 `#fff` + 1px `#eaeaeb` + 8px 圆角；告别深色 slate。
2. **主色**：`#165dff`（链接/按钮/激活 tab），品牌红 `#e93030` 只用于 logo 角标、发送按钮渐变（`#f5605b→#e93030`）这类小面积点睛——实证这就是问财的做法。
3. **涨跌**：涨 `#e93030`（或 `#f5222d`）跌 `#1faa59`（推断值），所有数字 `tabular-nums`，带 `+/-` 符号。
4. **字号**：正文 14、辅助 12、卡片标题 16、KPI 数字 20–28；不要全局 ≥16px。
5. **布局**：单栏对话流，max-width ~880px 居中；用户提问右侧浅蓝气泡 `#d3e0ff`；AI 回答全宽白底区，内部「结论段 → 核验结论卡（成立/存疑/不成立 + 置信度）→ 证据三栏卡（支持/反驳/关键数据）→ 数据表格」。
6. **过程**：提交后立即渲染竖向步骤时间轴（检索证据 → 提取指标 → 交叉核验 → 生成结论），每步带状态图标，完成即折叠成一行。
7. **表格**：TanStack Table，行高 36px、13px 字号、斑马纹 `#fafafa`；关键列数字右对齐。
8. **免责**：页脚固定「内容由 AI 生成，仅供研究参考，不构成投资建议」。
9. **组件落地**：assistant-ui 管对话流 + shadcn Card/Table/Badge 管数据件；不要自绘气泡组件。
10. **演示优先级**：核验结论卡 > 步骤时间轴 > 数据表格 > 图表。24h 内图表用一张 sparkline 即可。

---

## 未能实证/查不到的部分
- 问财对话结果页的真实截图（需登录+反爬，抓取的 SPA 壳不含渲染后 DOM）→ 以官方宣传 + token 推断。
- 同花顺涨跌红绿的官方精确色值 → 静态资源中未包含行情组件，给出推断区间。
- THSMoneyFont 不可公开获取 → 用 DIN/等宽数字替代。
