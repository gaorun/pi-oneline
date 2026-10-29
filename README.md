# pi-oneline

把 pi coding agent 的会话转录折叠成 Delta 风格：**一批工具调用只占一行**，明细按需展开，工作中有一行动态状态。

```text
▸ 3 calls · ls read grep · 2.2s
```

展开后（`ctrl+o`、点击该行，或 `alt+t`）：

```text
▸ 3 calls · ls read grep · 2.2s
  ├ ls    /Users/run/my-repos/pi-oneline  12 entries  0.1s
  ├ read  docs/DESIGN.md                  198 lines   0.2s
  └ grep  /汇总行/                        7 matches   0.3s
```

## 安装

```bash
# 本地目录（开发期）
pi install ./pi-oneline

# 单次试跑，不改配置
pi -e ./extensions/oneline

# 发布后
pi install npm:pi-oneline
```

## 三种模式

| 模式 | 行为 | 用在哪 |
|---|---|---|
| `group`（默认） | 一批调用占 1 行；除末行外其余行渲染 0 高度 | 日常使用 |
| `row` | 每次调用 1 行，结果默认不显示 | 想看清每条命令；也是 `group` 的降级形态 |
| `off` | 完全走 pi 原生渲染 | 排障、对比 |

切换：`/oneline off|row|group`，或用环境变量 `PI_ONELINE_MODE` 临时覆盖。

## 汇总行

```text
⠿ 3 calls · ls read grep · preparing            已声明、尚未执行
⠹ read docs/DESIGN.md · 2/3 · 1.4s              执行中，首字逐帧闪烁
⠿ 3 calls · ls read grep · 2.0s                 调用结束，等模型收尾
▸ 3 calls · ls read grep · 2.2s                  完成
▸ 3 calls · ls read grep · 2.4s · ⚠1             有调用失败
⊘ 2 calls · read bash · 1.4s · interrupted       被中断
```

宽度不够时按"先丢最不重要"降级：工具分布 → `calls` 状态词 → 耗时；失败标记 `⚠n` 任何宽度下都不丢。

## 命令与快捷键

| 操作 | 说明 |
|---|---|
| `/oneline` 或 `/oneline info` | 当前模式、标签、`hideThinkingBlock` 状态、配置路径、本回合调用数 |
| `/oneline off\|row\|group` | 切换模式并写入配置（对新组件生效） |
| `/oneline toggle` · `alt+t` · 点击该行 · `ctrl+o` | 展开/收起明细 |
| `/oneline setup` | 写入 `hideThinkingBlock=true` 并重载，让思考块折成 1 行 |
| `/oneline reset` | 还原 `hideThinkingBlock` 到 `setup` 之前的值 |

## 配置

`~/.pi/agent/pi-oneline.json`（可缺省）：

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

- `labels`：`en` / `zh`
- `markerStyle`：`braille`（`⠋⠙⠹…`）或 `dot`（`●○`）
- `shortcut`：设为 `""` 可关闭快捷键

## 验证

```bash
npm test                 # 纯逻辑单测（9 组断言，不需要 pi）
npm run test:integration # 真实 PTY 会话：group / 展开 / row / off
```

集成测试会在 PTY 里真的跑一次 pi 会话，采集渲染决策日志并断言：整批只有一行有内容、无同帧多行、降级后不回弹。

## 已知边界

| 边界 | 说明 |
|---|---|
| 思考块另占 1 行 | pi 原生渲染，扩展无法并入汇总行（标签即使设为空串仍渲染 1 行）。有思考的回合实际是 2 行 |
| 折叠依赖行高为零 | 依据是 pi 的"空 self-shell 渲染 0 行"行为；若上游改动，会退回 `row` 模式并提示，见 `docs/DESIGN.md` 附录 B |
| `group` 对既有渲染器的接管 | 其他扩展给工具加的自定义渲染会被本扩展覆盖；`off` 模式完全放行 |

完整规格见 [`docs/DESIGN.md`](docs/DESIGN.md)。
