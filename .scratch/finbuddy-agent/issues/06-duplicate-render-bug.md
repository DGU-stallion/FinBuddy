# 缺陷 #24：一次提问被渲染成两轮

Status: resolved
Type: bug-record
Resolved: 2026-10-13（commits `c35a40c`、`08efd32`）
Related: 缺陷表 #17（连点）、#22（输入法）—— **均非本次真因，是我的两次错误归因**

---

## 1. 用户看到的现象

> "为什么对话出现两次的情况还是出现，先定位问题"
> （这是用户**第三次**问同一件事；前两次我都声称已修复并交付）

一次提问后，界面上渲染出**两轮**回答区块：同一个提问气泡出现两次，
下面各跟一块完整的分析（时间轴、命题重构、三栏证据、追问按钮全都有）。

---

## 2. 真因（服务端流内事件顺序）

`app/api/chat/route.ts` 写出的流，**顺序错了**：

```
data-steps → data-plan → start → start-step → …      ❌
```

`start` 由 `writer.merge(result.toUIMessageStream({ sendStart: true }))` 带出。
AI SDK 的客户端消息归集以 `start` 为**新消息边界**，于是：

1. `data-steps` / `data-plan` 先到 → 客户端开出**第一条** assistant 消息（装这两个 part）；
2. `start` 到达 → 客户端开出**第二条** assistant 消息；
3. 剩下的正文、`data-refs`、`data-contract`、`data-followups` 全落在第二条上。

⇒ **单次 HTTP 请求 → 客户端 2 条 assistant 消息** → `deriveViews` 生成 2 个
article → 同一提问渲染两轮。与模型无关，**每次请求必然复现**。

### 最小复现（已实测）

| 流内顺序 | 客户端 assistant 消息数 | 页面 article 数 |
| --- | --- | --- |
| `data-steps` + `data-plan` | 1 | 1 ✅ |
| `data-steps` + `data-plan` + `start` | **2** | **2** ❌ |
| `start` + `data-steps` + `data-plan` | 1 | 1 ✅ |

### 一个假阳性陷阱（差点让我再次误判）

回放真实流时，若把 `start` 上的 **`messageId` 去掉**，则**不会复现**：

| `start` 是否带 `messageId` | 位于 data-* 之后时的结果 |
| --- | --- |
| 带 | 2 条消息 ❌（真实情形） |
| 不带 | 1 条消息 ✅（**假阳性**） |

我的第一版回放脚本漏了 `messageId`，导致脚本**永远绿**（没有牙齿），
我一度以为自己又找错了方向。这是本仓库"测试变不红比测试失败更危险"的实例。

---

## 3. 修法

`app/api/chat/route.ts`：

1. 在 `execute` 开头**显式写 `start`**（第 0 步）；
2. `merge(...)` 的 `sendStart` 改为 **`false`**（避免再开一条消息）；
3. 合规拦截分支原先**完全不写 `start`**，一并补上，使不变量处处成立。

```ts
writer.write({ type: 'start' });                       // 0) 必须先写
writer.write({ type: 'data-steps', … });               // 1)
writer.write({ type: 'data-plan',  … });               // 2)
writer.merge(result.toUIMessageStream({
  sendStart: false,   // 3) start 已显式写出，再发会开第二条消息
  sendFinish: false,
}));
```

---

## 4. 为什么我前两次都修错了（本记录最重要的部分）

| 次数 | 我的判断 | 我做了什么 | 结果 |
| --- | --- | --- | --- |
| ① | "用户连点了" | `inFlight` 同步闸门 + 5 个连点用例 | 测试全绿，**问题依旧** |
| ② | "输入法选词误提交" | CDP 真实复现 + 红→绿验证 | 修好了**另一条**真缺陷，**问题依旧** |

**根本错误：把用户描述的「现象」当成了「机制」。**
用户说"出现两次"，我**默认**它等于"提交动作跑了两遍"，于是两次都在
**客户端提交路径**里找原因。而真相是：

> **提交只发生了一次，HTTP 请求也只有一次 —— 但它渲染出了两轮。**

"重复"要同时怀疑**提交路径**与**渲染路径**。我漏掉了后者。

---

## 5. 怎么才定位到的（方法上的转折）

停止推理，改为**观测**：

1. **抓流**：把真实 `/api/chat` 的完整 SSE 落盘（113922 字节 / 1799 个事件）；
2. **回放**：把这条流**原样**喂给真实浏览器 → 稳定复现（不依赖模型当时说什么）；
3. **二分截断**：对回放流逐段截断，发现**截到第 3 个事件**就已出现 2 条消息；
4. **最小复现**：把顺序对照成上表，锁定 `start` 的位置。

关键点：全程数的是**客户端 `messages` 数组**与**页面 article 数**，
而不是"请求发了几次"—— 这正是前两次误判时我一直在错的量。

---

## 6. 验证手段（均已做变异测试）

| 层 | 文件 | 断言 | 变异测试 |
| --- | --- | --- | --- |
| 协议 | `tests/route-offline.test.ts` | `start` 必须第一个 chunk 且恰好 1 次；data part 仍齐全 | 还原旧顺序 → ❌ 红；恢复 → ✅ 绿 |
| 协议 | `tests/route-offline.test.ts`（合规分支） | 合规分支同样满足该不变量 | 移除合规分支 `start` → ❌ 红；恢复 → ✅ 绿 |
| 浏览器 | `scripts/single-render-check.mjs` | 回放真实形状的流，数最终渲染轮次 | 把 `start` 挪到 data-* 之后 → ❌ 退出码 1；恢复 → ✅ 0 |
| 真机 | 手动 | 真实模型：`assistant=1, article=1` | — |

**为什么协议层与浏览器层都要**：协议层能确定性抓到顺序错，但"渲染成两轮"
是它的后果 —— 必须在真实浏览器里**数轮次**才算验证到用户看到的东西。

---

## 7. 残留更正（不得再声称的错误因果）

我为前两次错误归因写过文档与提交信息。已逐一更正为"这不是'两次'的真因"：

- `app/page.tsx` —— 输入法守卫的注释
- `scripts/ime-submit-check.mjs` —— 文件头
- `README.md` —— 缺陷表 #24 与"容易被误判成测试脆弱"一节
- `AI-USAGE.md` §3.11

**输入法那条缺陷（#22）确实是真缺陷**，只是不是用户看到的这条 ——
保留它及其验证脚本，但不得再用它解释用户的报告。

---

## 8. 验证记录（2026-10-13 实跑）

```
npx vitest run                      → 46 files / 558 passed / 0 skipped
tsc --noEmit                        → 干净
npm run lint                        → No ESLint warnings or errors
bash scripts/verify-isolated.sh     → 全套验证通过（dev server 未受影响）
node scripts/compliance-suite.mjs   → 6/6，exit 0
node scripts/single-render-check.mjs→ 退出码 0（一次提问只渲染一轮）
node scripts/ime-submit-check.mjs   → 退出码 0（选词未误发）

真实浏览器多轮复核：
  第 1 轮 → assistant=1 article=1
  第 2 轮 → assistant=2 article=2（两轮各一块，非重复）
  刷新后 → 仍是 2/2（持久化回填不重复）
  合规分支：assistant=1 article=1
```

---

## Comments

- 用户第三次追问时要求"**先定位问题**"—— 这个要求是对的：我前两次都在
  "先修"而不是"先定位"。定位手段（抓流 + 回放 + 二分）比任何推理都有效。
