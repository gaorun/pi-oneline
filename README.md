# pi-oneline

把 pi coding agent 的会话转录折叠成 Delta 风格：一回合一行摘要，可展开详情，工作中显示动态状态标记。

- 目标形态与交互规格：见 [`docs/DESIGN.md`](docs/DESIGN.md)
- 机制可行性验证（对 pi 1.4.0 真实组件跑通）：见 `spike/zero-height.mjs`，运行 `node spike/zero-height.mjs`

## 命名

`pi-oneline`：跟随 pi 生态的 `pi-` 前缀 + 短词惯例（`pi-lens`、`pi-btw`、`pi-fabric`、`pi-powerline-footer`、`pi-cc-extensions`），并避开 `pi-fold` / `pi-condense` / `pi-compact` 这三个已被"上下文折叠"占用的语义。候选与占用情况见 [`docs/DESIGN.md` 附录 C](docs/DESIGN.md)。

## 状态

- 显示规格定稿（汇总行语法、降级阶梯、展开视图、交互、配置）：`docs/DESIGN.md`
- 机制可行性验证通过：`node spike/zero-height.mjs` → **ALL PASS (10/10)**
- 未开始：扩展本体实现

