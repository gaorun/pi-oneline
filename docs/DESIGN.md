# pi-oneline 设计规格

目标：让 pi 的会话转录读起来像 Delta —— 模型思考与工具调用不再各占一块，而是收成一行摘要，可展开看详情，工作中有一个动态标记。

## 1. 范围

| 折叠 | 不折叠 |
|---|---|
| 一次模型回合内的全部工具调用 | 用户消息 |
| 模型思考块（压到 1 行，见 §5） | 助手输出正文 |
| 工具调用的参数与结果预览 | 错误/中断提示、压缩摘要、扩展自定义消息 |

## 2. 三种显示层级

| 模式 | 行为 |
|---|---|
| `off` | 完全保留 pi 原生渲染（用于对比与排障） |
| `row` | 每次工具调用压成 1 行，结果不占行（保守形态，纯公开 API） |
| `group`（默认） | 同一回合的全部调用合成 **1 行**，其余行 0 高度 |

## 3. 汇总行语法

```
<标记> <n> calls · <工具分布> · <耗时>[ · ⚠<失败数>]
```

实际渲染样例（`group` 模式，宽度 80）：

```text
▸ 4 calls · read×2 bash edit · 8.2s
```

运行中（首字为逐帧标记，行尾耗时为滚动耗时）：

```text
⠹ read src/app.ts · 2/4 · 3.1s
```

有失败：

```text
▸ 4 calls · read×2 bash edit · 8.4s · ⚠1
```

被用户中断：

```text
⊘ 2 calls · read bash · 1.4s · interrupted
```

中文标签（`labels: "zh"`）：

```text
▸ 4 次调用 · read×2 bash edit · 8.2s
```

### 3.1 字形与状态

| 场景 | 标记 | 颜色 |
|---|---|---|
| 有调用正在执行 | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 循环（可配 `● ○`） | accent |
| 调用已结束、等待模型 | `⠿` | dim |
| 回合结束、全部成功 | `▸` | dim |
| 回合结束、有失败 | `▸` | error 前缀，尾部 `⚠n` |
| 被中断 | `⊘` | warning |

### 3.2 字段规则

| 字段 | 规则 |
|---|---|
| `<n> calls` | 本回合顶层工具调用数；不含 `parentToolCallId` 存在的嵌套调用（它们不进转录） |
| 工具分布 | 按首次出现顺序；同名重复写 `bash×3`；不同工具 ≤3 个全列，>3 个列前 3 后接 `+n` |
| 耗时 | 首个 `tool_execution_start` → 本回合最后一次 `turn_end` 的墙钟时间；<1s 显示 `0.7s`，≥60s 显示 `1m12s` |
| 失败数 | `isError === true` 的调用数，为 0 时省略该段 |
| 运行中计数 | `2/4` = 已完成/本回合已发起 |
| 单复数 | 1 次调用写 `1 call`，其余写 `n calls`（zh：`1 次调用` / `n 次调用`） |
| `preparing` | 模型已声明工具调用、但尚未开始执行（参数还在流式生成）时的状态词，实测存在且会停留数百毫秒，不能省略 |

### 3.3 宽度降级

按"先丢最不重要"的顺序降级，始终保持在终端宽度内：

| 顺序 | 降级动作 | 该级形态 |
|---|---|---|
| 1 | 丢掉工具分布 | `▸ 4 calls · 8.2s` |
| 2 | 丢掉 `calls` 状态词 | `▸ 4 · 8.2s` |
| 3 | 丢掉耗时 | `▸ 4 · ⚠1`（有失败）或 `▸ 4` |

失败尾注 `⚠n` 任何宽度下都不丢弃：它决定这一回合要不要点开看。所有行经 `truncateToWidth()` 处理，中文与 emoji 按显示列宽计算。

### 3.4 实测的状态序列（真实会话，`--tui-mode regular`）

```text
⠿ 1 call · ls · preparing
⠿ 2 calls · ls read · preparing
⠿ 3 calls · ls read grep · preparing
▸ 3 calls · ls read grep · 0.1s
▸ 3 calls · ls read grep · 1.7s
```

同一行内文本递增，不产生新行。最后一行从 `0.1s` 变为 `1.7s` 是 `turn_end` 把耗时终点从"最后一次工具结束"改判为"回合结束"（§3.2）。

## 4. 展开视图

展开后仍只占该行，明细逐条列出：

```text
▸ 4 tool calls · read×2 bash edit · 8.2s
  ├ read   src/app.ts                   42 lines   0.3s
  ├ read   src/util.ts                  18 lines   0.2s
  ├ bash   npm test                     exit 0     6.9s
  └ edit   src/app.ts                   +12 −3     0.4s
```

- 每条为 1 行：`名称 · 参数摘要 · 结果摘要 · 单次耗时`
- 结果摘要按工具取：`read` → `42 lines`；`grep`/`find` → `12 matches` / `7 files`；`bash` → `exit 0`；`edit` → `+12 −3`；`write` → `118 lines`；其他与 MCP → `ok` / `error`
- 超过 12 条时只列前 12 条，末尾追加 `  └ … +18 more`
- 单次耗时来自渲染上下文的 `durationMs`；缺失时省略该列

## 5. 与思考块的关系（边界）

- pi 仅在模型产生 thinking 内容时才渲染思考块；开启 `hideThinkingBlock` 后固定为 1 行斜体标签。
- 该行由 pi 原生渲染，扩展**无法并入汇总行，也无法删除**。实测：`theme.italic(theme.fg("thinkingText", ""))` 求值为 `\x1b[39m\x1b[2m\x1b[22;39m`（17 字节），`new Text(...).render(80)` 返回 **1 行**；只有真正的 `Text("")` 返回 0 行，而 `theme.italic()` 必然给空串加上转义码。
- 结论：每个有思考的回合占 **2 行**（思考标签 + 汇总行），无思考的回合占 **1 行**。
- 标签默认 `⋯ thinking` / 中文 `⋯ 思考`，不含耗时（标签是会话级全局值，无法逐回合改写）。

## 6. 交互

| 操作 | 行为 |
|---|---|
| 点击汇总行 | 展开/收起（fullscreen 模式） |
| `ctrl+o` | pi 原生"展开全部工具输出"，汇总行跟随（语义一致，不额外拦截） |
| `alt+t`（可配） | 只切换 pi-oneline 的明细视图 |
| `/oneline` | `off \| row \| group` 切换模式 |
| `/oneline info` | 显示当前模式、本回合统计、生效配置路径 |

## 7. 配置

`~/.pi/agent/pi-oneline.json`（缺失时用默认值）：

```json
{
  "mode": "group",
  "labels": "en",
  "markerStyle": "braille",
  "maxDetailLines": 12,
  "shortcut": "alt+t",
  "hideThinking": true
}
```

`hideThinking: true` 需要 `~/.pi/agent/settings.json` 里的 `hideThinkingBlock: true`。

**生效时机很重要**：该值由 `SettingsManager` 在启动时读入内存，扩展没有运行时修改它的 API；只有 `session.reload()` 会 `settingsManager.reload()` 重读文件（`dist/core/agent-session.js:2996-3007`），交互层随后按新值重建转录（`dist/modes/interactive/interactive-mode.js:5363`）。所以：

- `/oneline setup`：写入 `hideThinkingBlock: true`（先记改前值），再调用 `ctx.reload()` 立即生效；
- `session_start` 只做检测：值为 `false` 时提示一次"运行 `/oneline setup` 折叠思考"，**不静默改写**；
- `/oneline reset`：还原改前值并 `ctx.reload()`。

## 8. 非目标

- 不改动发给模型的上下文（纯显示层）
- 不改变工具执行与结果内容
- 不做日志/链路类功能

## 附录 A：机制验证（对 pi 1.4.0 实机跑通）

`spike/zero-height.mjs` 直接 import pi 发行包里转录使用的 `ToolExecutionComponent`，不做 mock，覆盖真实时序，10 项断言全部通过：

| 断言 | 结论 |
|---|---|
| 非 owner 行可渲染为 0 行 | ✅ `renderShell:"self"` + 空内容 → `render()` 返回 `[]` |
| 新调用到达时旧行可被压下去 | ✅ 渲染上下文暴露的 `invalidate()` 会让该行重跑渲染器 |
| 旧行结果晚到不会顶出来 | ✅ `updateResult()` 触发的重渲染同样返回 0 行 |
| 整批只占 1 行 | ✅ |
| 展开后明细仍在同一行内 | ✅ `setExpanded()` 走 `updateDisplay()` 重跑 `renderResult` |
| `/resume` 重建不依赖 invalidate | ✅ 渲染器自算"我是否末行"，重建顺序即正确 |
| 失败计数进入汇总行 | ✅ |

关键依据（pi 1.4.0 源码）：

| 事实 | 位置 |
|---|---|
| self shell 空内容 → 该行 0 行 | `dist/modes/interactive/components/tool-execution.js:159-168` |
| 渲染上下文的 `invalidate` = 组件失效 + `requestRender` | 同上 `:74-81` |
| `setExpanded` → `updateDisplay()` 重跑渲染器 | 同上 `:139-142` |
| 单次耗时由 `durationMs` 提供 | 同上 `:96` |
| 思考块折叠为单行 `Text` | `dist/modes/interactive/components/assistant-message.js:110-118` |
| 工具事件无 batch/message id，只能按回合切批 | `dist/core/extensions/types.d.ts:853` |

### A.2 真实会话验证（`npm run test:integration`）

在 PTY 里跑真实 pi 会话（`pi -e extensions/oneline --tui-mode regular`），扩展把每次渲染决策写进 JSONL（`PI_ONELINE_DEBUG`），脚本据此断言。

| 场景 | 命令 | 结果 |
|---|---|---|
| `group`，3 次调用 | `python3 spike/run-probe.py` | 末态 1 行，同帧多行 0 次，回弹 0 次 |
| `group` + `ctrl+o` 展开 | `... --expand` | 明细 3 行，仍只有 1 个工具块有内容 |
| `group` + `alt+t` | `... --keys '\x1bt'` | 明细 3 行，快捷键生效 |
| `row` | `... --mode row --max-visible 3` | 3 行，无回弹 |
| `off` | `... --mode off` | 渲染事件 0 个（完全走原生） |
| `/oneline info` | `... --cmd "/oneline info" --expect "配置："` | 命令执行并回显配置 |

补充结论：

- **必须在 `message_start`/`message_update` 就预注册本批调用顺序**，不能等 `tool_execution_start`。实测 pi 会在参数流式阶段一次建好全部工具组件；晚注册会有 1 帧双行。
- 失败标记可用：模型把 `docs/DESIGN.md` 传成 `DESIGN.md` 时返回 `Path not found`，汇总行显示 `⚠1`；而 `grep` 的"无匹配"在 `dist/core/tools/grep.js:194` 返回无 `isError` 的正常结果，不会误报。
- 耗时终点取 `turn_end`：若取"最后一次工具结束"，3 个并行调用只跑 46ms，会显示 `0.0s`。

## 附录 B：已知风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 依赖 `ToolExecutionComponent` 的内部渲染时序 | pi 升级可能失效 | **无法**在扩展里构造假行自检：包的 `exports` 白名单挡住了 `dist/...` 深引用（实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。改为运行时降级保护：渲染器抛错、或一次回合里渲染器从未被调用，就退回 `row` 模式并提示一次 |
| 隐藏行仍存在于转录模型 | HTML 导出可能缺详情 | 导出前切到 `row` 模式（`PI_ONELINE_MODE=row pi export ...`） |
| `ctrl+o` 会连带展开隐藏行 | 展开后可能出现空行区块 | 隐藏行在任何 `expanded` 取值下都渲染 0 行（与展开态解耦） |
| 与其他工具渲染扩展冲突 | 互相覆盖 | 用 `registerToolRenderer(name, next)` 的 `next()` 先取既有实现 |
| 流式中行数抖动 | 观感 | 旧行降级发生在下一行创建时，同帧完成，实测无中间态 |

## 附录 C：命名调研

按 pi 官方包目录（`pi.dev/packages`，5620 个包）的命名惯例：`pi-` 前缀 + 短词为主，显示层插件用"部位/效果词"命名。

| 参考包 | 月下载 | 形态 | 与本项目的关系 |
|---|---|---|---|
| `pi-cc-extensions` | 51.3K | `pi-` + 缩写，Claude Code 风格 TUI 输出 | 最近的同类竞品，说明"显示层改造"是成熟需求 |
| `pi-powerline-footer` | 74.1K | `pi-` + 界面部位 | 只改 footer，不碰转录 |
| `pi-lens` / `pi-btw` / `pi-fabric` / `pi-goal-x` | 32K~80K | `pi-` + 短词 | 主流命名形态 |
| `pi-subagents` / `pi-simplify` / `pi-memory` | 38K~630K | `pi-` + 功能词 | 描述性命名同样常见 |

候选名与 npm 占用情况（实查）：

| 候选 | npm | 取舍 |
|---|---|---|
| **`pi-oneline`** | 未占用 | ✅ 选定：直接表达"一回合一行"，且不与上下文折叠类插件撞语义 |
| `pi-fold` | 已占用 4.3.0（上下文折叠） | ✗ 语义冲突 |
| `pi-condense` | 已占用 2.13.1（批次摘要压缩） | ✗ 语义冲突 |
| `pi-compact` | 已占用 0.7.0（上下文压缩） | ✗ 语义冲突 |
| `pi-collapse` | 未占用 | 与 `pi-fold`/`pi-condense` 的"上下文折叠"易混 |
| `pi-turn-fold` | 未占用 | 准确但拗口 |
| `pi-foldline` / `pi-disclosure` / `pi-transcript` / `pi-digest` | 未占用 | 都不如 `oneline` 直观 |
