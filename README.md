# pi-oneline

把 pi coding agent 的会话转录折叠成 Delta 风格：**一批工具调用只占一行**，明细可展开，工作中有动态状态。

```text
▸ 3 calls · ls read grep · 1.7s
```

状态：`v0.1.0` 已发布（tag + GitHub），可从 git 仓库安装，见「三、安装」。

## 一、要解决的问题

pi 的转录按「一块一则」渲染：每次工具调用占一片，参数预览与结果预览又各占一片。模型一回合连跑几个工具，转录就被撑开——想顺着读模型的思路，得一路翻过工具输出。

已有的折叠类插件（`pi-fold`、`pi-condense`、`pi-compact`）处理的是 **token**：把旧内容从发给模型的上下文里摘掉。pi-oneline 处理的是 **阅读**：发给模型的内容一条不改，只在显示层收起来。

| 维度 | pi 原生 | pi-oneline |
|---|---|---|
| 一回合的多次工具调用 | 各占一片，参数与结果预览都在 | 合成 1 行 |
| 明细 | 全程铺开 | 点开才出，收起不动上下文 |
| 运行中 | 各块分别刷新 | 1 行：动态标记 + 已完成/总数 + 滚动耗时 |
| 有失败的回合 | 需逐块查看 | 汇总行尾 `⚠n`，任何宽度下都不丢 |

## 二、效果

真实会话的渲染序列（`--tui-mode regular`，3 次工具调用）——同一行内文本递增，不产生新行：

```text
⠿ 1 call · ls · preparing
⠿ 2 calls · ls read · preparing
⠿ 3 calls · ls read grep · preparing
▸ 3 calls · ls read grep · 0.1s
▸ 3 calls · ls read grep · 1.7s
```

汇总行的状态标记：

| 状态 | 形态 |
|---|---|
| 已声明、尚未执行 | `⠿ 3 calls · ls read grep · preparing` |
| 执行中（首字逐帧闪烁） | `⠹ read docs/DESIGN.md · 2/3 · 1.4s` |
| 调用结束、等模型收尾 | `⠿ 3 calls · ls read grep · 2.0s` |
| 完成 | `▸ 3 calls · ls read grep · 1.7s` |
| 有调用失败 | `▸ 3 calls · ls read grep · 1.7s · ⚠1` |
| 被中断 | `⊘ 2 calls · read bash · 1.4s · interrupted` |

展开后仍只占该行，明细逐条跟在该行下面（`ctrl+o`、`alt+t` 或点击该行）：

```text
▸ 3 calls · ls read grep · 2.2s
  ├ ls    /Users/run/my-repos/pi-oneline  12 entries  0.1s
  ├ read  docs/DESIGN.md                  198 lines   0.2s
  └ grep  /汇总行/                        7 matches   0.3s
```

超过 `maxDetailLines`（默认 12）条时只列前 12 条，末尾追加 `… +n more`。

## 三、安装

两种来源，任选其一。

**从 git 仓库（推荐，可锁版本）**

```bash
pi install git:github.com/gaorun/pi-oneline@v0.1.0
pi list                                             # 确认已登记
```

git 源按 tag / commit 固定：`@v0.1.0` 之后 main 再往前走，本地也不会跟着变。升级要显式换成新 tag，或执行 `pi update --extensions` 让 pi 重新对齐。装了哪个 ref、落在哪个目录，`pi list` 会直接列出来。

**从本地目录（开发期）**

```bash
pi install ./pi-oneline        # 写入 ~/.pi/agent/settings.json
pi list
pi -e ./extensions/oneline     # 单次试跑，不改配置
```

卸载：`pi remove git:github.com/gaorun/pi-oneline@v0.1.0`（换成你实际装的来源）。

依赖 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-tui` 由 pi 侧提供，走 `peerDependencies`，不随包安装。

## 四、三种模式

| 模式 | 行为 | 用在哪 |
|---|---|---|
| `group`（默认） | 一批调用占 1 行；除末行外其余行渲染 0 高度 | 日常使用 |
| `row` | 每次调用 1 行，结果默认不显示 | 想看清每条命令；也是 `group` 的降级形态 |
| `off` | 完全走 pi 原生渲染 | 排障、对比 |

切换：`/oneline off|row|group`（写入配置，对新组件生效），或 `PI_ONELINE_MODE=row pi ...` 临时覆盖。

宽度不够时按「先丢最不重要」降级：工具分布 → `calls` 状态词 → 耗时。失败尾注 `⚠n` 任何宽度下都不丢：它决定这一回合要不要点开看。

## 五、命令与配置

| 操作 | 说明 |
|---|---|
| `/oneline` 或 `/oneline info` | 当前模式、标签、`hideThinkingBlock` 状态、配置路径、本回合调用数 |
| `/oneline off\|row\|group` | 切换模式并写入配置 |
| `/oneline toggle` · `alt+t` · 点击该行 · `ctrl+o` | 展开/收起明细 |
| `/oneline setup` | 写入 `hideThinkingBlock=true` 并重载，让思考块折成 1 行 |
| `/oneline reset` | 把 `hideThinkingBlock` 还原成 `setup` 之前的值 |

`~/.pi/agent/pi-oneline.json`（可缺省；非法值退回默认，不报错）：

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

| 键 | 取值 |
|---|---|
| `mode` | `off` / `row` / `group` |
| `labels` | `en` / `zh` |
| `markerStyle` | `braille`（`⠋⠙⠹…`）或 `dot`（`●○`） |
| `maxDetailLines` | 展开时最多列几条，默认 12 |
| `shortcut` | 设成 `""` 可关闭快捷键 |
| `hideThinking` | `true` 时提示折叠思考块，配合 `/oneline setup` |

两个环境变量：`PI_AGENT_DIR` 改写配置目录，`PI_ONELINE_DEBUG` 指定路径后把渲染决策写成 JSONL（集成测试据此断言）。

## 六、验证

```bash
npm test                    # 纯逻辑单测，不需要 pi 运行时
npm run test:integration    # 在 PTY 里跑真实 pi 会话
```

单测覆盖汇总行的结束态、单复数、失败尾注、宽度降级、中文标签、明细行数截断等 9 组断言。

集成测试脚本覆盖 `group`、展开、`row`、`off` 四个场景，断言：末态只有一行有内容、同帧不会出现双行、降级后不回弹。`alt+t` 快捷键与 `/oneline info` 的验证见 DESIGN 附录 A.2。

## 七、已知边界

| 边界 | 说明 |
|---|---|
| 有思考的回合占 2 行 | 思考标签由 pi 原生渲染，扩展无法并入汇总行（实测：标签设为空串仍渲染 1 行）。无思考的回合才是真正的 1 行 |
| 依赖 pi 的内部渲染时序 | `group` 靠「空 self-shell 渲染 0 行」+ 定向 `invalidate()` 成立，属版本跟随成本。不能启动自检——包的 `exports` 白名单挡住了 `dist/` 深引用；改为运行时保护：渲染器报错或整回合未被调用，就退回 `row` 并提示一次 |
| 只在 pi 1.4.0 上验证过 | 机制与字段均据 1.4.0 源码定；`peerDependencies` 未固定版本下限，pi 升级后应重跑 `npm run test:integration` |
| 会在 `message_start` 预注册本批调用 | pi 在参数流式阶段一次建好全部工具组件，晚注册会出现 1 帧双行 |
| 接管其他扩展的工具渲染 | `group`/`row` 下会覆盖它们给工具加的自定义渲染；`off` 完全放行 |
| HTML 导出可能缺详情 | 隐藏行仍在转录模型里。导出前切 `row`：`PI_ONELINE_MODE=row pi export ...` |

## 八、不做

- 不改动发给模型的上下文（纯显示层）
- 不改变工具执行与结果内容
- 不做日志、链路类功能
- 不追求删掉思考块——做不到，只能压到 1 行

## 九、文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 规格全集：汇总行语法与字段规则、字形与状态、实测状态序列、降级阶梯、展开视图、思考块边界、交互、配置、非目标、机制验证、已知风险、命名调研 |
| `spike/zero-height.mjs` | 机制验证脚本，对真实 pi 组件跑时序断言 |
| `spike/run-probe.py` | PTY 集成探针，采集渲染决策 JSONL 并断言 |

命名沿用 pi 生态的 `pi-` 前缀 + 短词惯例，避开已被「上下文折叠」占用的 `pi-fold` / `pi-condense` / `pi-compact`；调研见 DESIGN 附录 C。
