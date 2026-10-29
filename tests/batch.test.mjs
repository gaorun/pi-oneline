// 纯逻辑单测：不依赖 pi 运行时（batch.ts 只 import type）。
import assert from "node:assert/strict";
import { Batch, detailLines, elapsedOf, summaryLine } from "../extensions/oneline/batch.ts";

const plainPalette = { dim: (s) => s, muted: (s) => s, accent: (s) => s, warning: (s) => s, error: (s) => s, bold: (s) => s };
const plain = (fn) => {
        const out = fn(plainPalette);
        return out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
};
const cfg = { labels: "en", markerStyle: "braille", maxDetailLines: 12 };

function makeBatch(specs) {
        const b = new Batch();
        specs.forEach((s) => {
                const rec = b.ensure(s.id, s.name);
                if (s.start !== undefined) rec.startedAt = s.start;
                if (s.end !== undefined) rec.endedAt = s.end;
                rec.durationMs = s.end !== undefined && s.start !== undefined ? s.end - s.start : undefined;
                rec.target = s.target ?? "";
                rec.result = s.result ?? "";
                rec.isError = !!s.isError;
        });
        return b;
}

const opts = (b, extra = {}) => ({ cfg: { ...cfg, ...extra.cfg }, now: extra.now ?? 10_000, frame: 0, width: extra.width ?? 80, p: plainPalette });

// 1. 结束态：3 次调用
{
        const b = makeBatch([
                { id: "a", name: "ls", start: 1000, end: 1100 },
                { id: "b", name: "read", start: 1100, end: 1500 },
                { id: "c", name: "read", start: 1500, end: 2000 },
        ]);
        b.turnEndedAt = 3000;
        assert.equal(plain((p) => summaryLine(b, { ...opts(b), p })), "▸ 3 calls · ls read×2 · 2.0s");
}

// 2. 单复数 + 失败尾注
{
        const b = makeBatch([{ id: "a", name: "bash", start: 0, end: 500 }]);
        b.calls[0].isError = true;
        b.turnEndedAt = 500;
        assert.equal(plain((p) => summaryLine(b, { ...opts(b), p })), "▸ 1 call · bash · 0.5s · ⚠1");
}

// 3. 运行中：当前工具 + 完成数
{
        const b = makeBatch([
                { id: "a", name: "ls", start: 1000, end: 1200, target: "." },
                { id: "b", name: "bash", start: 1200, target: "npm test" },
        ]);
        const line = plain((p) => summaryLine(b, { ...opts(b, { now: 3000 }), p }));
        assert.match(line, /^⠋ bash npm test · 1\/2 · 2\.0s$/);
}

// 4. 已声明未执行（preparing）
{
        const b = makeBatch([
                { id: "a", name: "ls" },
                { id: "b", name: "read" },
        ]);
        assert.equal(plain((p) => summaryLine(b, { ...opts(b), p })), "⠿ 2 calls · ls read · preparing");
}

// 5. 中断
{
        const b = makeBatch([{ id: "a", name: "read", start: 1000 }]);
        b.interrupted = true;
        assert.equal(plain((p) => summaryLine(b, { ...opts(b, { now: 1500 }), p })), "⊘ 1 call · read · 0.5s · interrupted");
}

// 6. 宽度降级阶梯
{
        const b = makeBatch([
                { id: "a", name: "bash", start: 0, end: 100 },
                { id: "b", name: "read", start: 100, end: 200 },
                { id: "c", name: "edit", start: 200, end: 300 },
        ]);
        b.turnEndedAt = 300;
        const full = plain((p) => summaryLine(b, { ...opts(b, { width: 80 }), p }));
        const mid = plain((p) => summaryLine(b, { ...opts(b, { width: 22 }), p }));
        const tight = plain((p) => summaryLine(b, { ...opts(b, { width: 9 }), p }));
        assert.equal(full, "▸ 3 calls · bash read edit · 0.3s");
        assert.ok(mid.length <= 22, `mid=${mid}`);
        assert.ok(tight.length <= 9, `tight=${tight}`);
        assert.ok(tight.startsWith("▸"), tight);
}

// 7. 中文标签
{
        const b = makeBatch([{ id: "a", name: "read", start: 0, end: 200 }]);
        b.turnEndedAt = 200;
        assert.equal(plain((p) => summaryLine(b, { ...opts(b, { cfg: { labels: "zh" } }), p })), "▸ 1 次调用 · read · 0.2s");
}

// 8. 明细行与截断
{
        const specs = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: "read", start: 0, end: 100, target: `f${i}.ts`, result: `${i + 1} lines` }));
        const b = makeBatch(specs);
        const lines = detailLines(b, { cfg, p: plainPalette }).map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
        assert.equal(lines.length, 5);
        assert.match(lines[0], /├ read\s+f0\.ts\s+1 lines/);
        assert.match(lines[4], /└ read/);

        const capped = detailLines(b, { cfg: { ...cfg, maxDetailLines: 3 }, p: plainPalette }).map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
        assert.equal(capped.length, 4);
        assert.match(capped[3], /\+2/);
}

// 9. 耗时口径：turnEndedAt 优先于最后一次工具结束
{
        const b = makeBatch([{ id: "a", name: "ls", start: 1000, end: 1100 }]);
        assert.equal(elapsedOf(b, 5000), "0.1s");
        b.turnEndedAt = 4000;
        assert.equal(elapsedOf(b, 9000), "3.0s");
}

// 10. 多轮隔离：上一轮冻结后，当前轮的变化不得影响它
{
        const prev = makeBatch([
                { id: "p1", name: "ls", start: 0, end: 100 },
                { id: "p2", name: "read", start: 100, end: 200 },
        ]);
        prev.turnEndedAt = 200;
        prev.freeze(false);
        const before = plain((p) => summaryLine(prev, { ...opts(prev, { now: 10_000 }), p }));

        // 第二轮进行中
        const cur = makeBatch([
                { id: "c1", name: "bash", start: 1000, end: 1200 },
                { id: "c2", name: "edit", start: 1200, end: 1400 },
                { id: "c3", name: "grep", start: 1400, end: 1600 },
        ]);
        const after = plain((p) => summaryLine(prev, { ...opts(prev, { now: 10_000 }), p }));

        assert.equal(before, "▸ 2 calls · ls read · 0.2s");
        assert.equal(after, before, "上一轮的汇总被当前轮改动了");
        // 未 fetch turn_end：耗时量到"最后一次工具结束"= 1600-1000 = 0.6s
        assert.equal(plain((p) => summaryLine(cur, { ...opts(cur, { now: 2000 }), p })), "▸ 3 calls · bash edit grep · 0.6s");
}

// 11. 每个批次有独立 id
{
        const a = new Batch();
        const b = new Batch();
        assert.notEqual(a.id, b.id);
}

// 12. 冻结后的耗时不再滚动
{
        const b = makeBatch([{ id: "x", name: "ls", start: 1000, end: 1500 }]);
        b.turnEndedAt = 2000;
        b.freeze(false);
        assert.equal(elapsedOf(b, 99_000), "1.0s");
}

console.log("batch.test.mjs: 12 组断言全部通过");
