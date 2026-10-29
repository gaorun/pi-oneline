// Spike: 验证「同一批工具调用中，只有末行渲染聚合摘要，其余行 0 高度」，
// 覆盖真实时序：调用先到达、结果后到达、新调用不断把旧行降级。
// 直接 import pi 1.4.0 dist 里的 ToolExecutionComponent，不做 mock。
import { pathToFileURL } from "node:url";

const PI = "/Users/run/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent";
const { ToolExecutionComponent } = await import(pathToFileURL(`${PI}/dist/modes/interactive/components/tool-execution.js`).href);
const { Text } = await import(pathToFileURL(`${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`).href);

const batch = { rows: [], calls: new Map() };
const contexts = new Map();
const rows = new Map();
const lastId = () => batch.rows[batch.rows.length - 1];
const ui = { requestRender() {} };
const WIDTH = 80;

function summaryLines() {
  const calls = batch.rows.map((id) => batch.calls.get(id));
  const counts = calls.reduce((m, c) => ((m[c.name] = (m[c.name] ?? 0) + 1), m), {});
  const parts = Object.entries(counts).map(([n, c]) => (c > 1 ? `${n}x${c}` : n));
  const failed = calls.filter((c) => c.isError).length;
  return [
    `> ${calls.length} tool calls - ${parts.join(" ")}${failed ? ` - ${failed} failed` : ""}`,
    ...(batch.expanded ? calls.map((c) => `  |- ${c.name} ${c.args.path ?? ""} ${c.isError ? "FAILED" : "ok"}`) : []),
  ];
}

const def = {
  name: "read",
  label: "read",
  renderShell: "self",
  renderCall(args, _theme, ctx) {
    contexts.set(ctx.toolCallId, ctx);
    batch.expanded = ctx.expanded;
    return new Text(ctx.toolCallId === lastId() ? summaryLines()[0] : "");
  },
  renderResult(_r, opts, _theme, ctx) {
    contexts.set(ctx.toolCallId, ctx);
    batch.expanded = opts.expanded;
    if (ctx.toolCallId !== lastId() || !opts.expanded) return new Text("");
    const id = ctx.toolCallId;
    return new Text(`  |- ${batch.calls.get(id).name} ${batch.calls.get(id).args.path ?? ""}`);
  },
};

const visible = (id) => rows.get(id).render(WIDTH).filter((l) => l.trim());
const painted = () => batch.rows.filter((id) => visible(id).length > 0);
function report(label) {
  const out = batch.rows.map((id) => `${id}:${visible(id).length}`).join(" ");
  console.log(`${label.padEnd(26)} ${out}  | ${visible(lastId()).join(" / ")}`);
  return painted();
}
const checks = [];
const assert = (n, ok) => (checks.push([n, ok]), console.log(`${ok ? "PASS" : "FAIL"}  ${n}`));

function arrive(name, isError = false) {
  const id = `call-${batch.rows.length + 1}`;
  batch.rows.push(id);
  batch.calls.set(id, { name, args: { path: `${id}.ts` }, isError });
  const prev = batch.rows[batch.rows.length - 2];
  const row = new ToolExecutionComponent(name, id, batch.calls.get(id).args, undefined, def, ui, process.cwd());
  rows.set(id, row);
  if (prev) contexts.get(prev)?.invalidate(); // 新调用到达 → 旧行降级
  return id;
}
function complete(id, isError = false) {
  rows.get(id).updateResult({ content: [{ type: "text", text: `output of ${id}` }], details: {}, isError });
}

console.log("=== stage 1: 调用先到、结果后到 ===");
const a = arrive("read");
assert("首个调用到达，恰一行可见", report("arrive call-1").length === 1);
const b = arrive("bash");
assert("第二个调用到达，仍恰一行可见", report("arrive call-2").length === 1);
complete(a);
assert("旧行结果晚到后仍是 0 行（不会把已折叠的行顶出来）", report("result call-1").length === 1);
complete(b);
assert("末行结果到达后仍是 1 行", report("result call-2").length === 1);

const c = arrive("read");
complete(c);
const one = report("turn_end");
assert("整批只占 1 行", one.length === 1);
assert("汇总含调用数与分布", /3 tool calls/.test(visible(one[0])[0]) && /readx2/.test(visible(one[0])[0]));

console.log("\n=== stage 2: 展开仍锁在同一行 ===");
rows.get(one[0]).setExpanded(true);
const exp = batch.rows.map((id) => visible(id).length).join(",");
console.log(`展开后各行可见行数: ${exp}`);
assert("展开后依然只有末行有内容", painted().length === 1);
assert("明细出现在末行内（1 行摘要 + 1 行明细）", visible(one[0]).length === 2);
rows.get(one[0]).setExpanded(false);

console.log("\n=== stage 3: /resume 重建（不依赖 invalidate） ===");
rows.clear();
const rebuilt = batch.rows.map((id) => {
  const r = new ToolExecutionComponent(batch.calls.get(id).name, id, batch.calls.get(id).args, undefined, def, ui, process.cwd());
  rows.set(id, r);
  return visible(id).length;
});
console.log(`重建后各行可见行数: ${rebuilt.join(",")}`);
assert("重建后只有末行有内容", rebuilt.slice(0, -1).every((n) => n === 0) && rebuilt.at(-1) === 1);

console.log("\n=== stage 4: 失败态 ===");
const d = arrive("bash", true);
complete(d, true);
const err = painted();
assert("失败计数进入汇总行", /1 failed/.test(visible(err[0]).join(" ")));

const ok = checks.every(([, v]) => v);
console.log(`\n${ok ? "ALL PASS" : "SOME FAILED"} (${checks.filter(([, v]) => v).length}/${checks.length})`);
process.exitCode = ok ? 0 : 1;
