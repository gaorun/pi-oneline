/**
 * 批次状态与文案生成。纯逻辑：不依赖 pi 运行时，可在 node 里直接单测。
 */
import type { Config, Labels } from "./config.ts";

export interface CallRec {
        id: string;
        name: string;
        /** 参数摘要，例如 `src/app.ts` 或 `npm test`。 */
        target: string;
        /** 结果摘要，例如 `42 lines` 或 `exit 0`。 */
        result: string;
        startedAt?: number;
        endedAt?: number;
        durationMs?: number;
        isError: boolean;
}

export interface Palette {
        dim: (s: string) => string;
        muted: (s: string) => string;
        accent: (s: string) => string;
        warning: (s: string) => string;
        error: (s: string) => string;
        bold: (s: string) => string;
}

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DOTS = ["●", "○"];

const WORDS: Record<Labels, { calls: (n: number) => string; preparing: string; waiting: string; interrupted: string }> = {
        en: {
                calls: (n) => (n === 1 ? "1 call" : `${n} calls`),
                preparing: "preparing",
                waiting: "waiting",
                interrupted: "interrupted",
        },
        zh: {
                calls: (n) => (n === 1 ? "1 次调用" : `${n} 次调用`),
                preparing: "准备中",
                waiting: "等待模型",
                interrupted: "已中断",
        },
};

let nextBatchId = 1;

export class Batch {
        /** 每轮一个批次；结束即冻结，后续渲染只读它的快照。 */
        readonly id = nextBatchId++;
        calls: CallRec[] = [];
        turnEndedAt: number | undefined;
        interrupted = false;
        private invalidators = new Map<string, () => void>();

        /** 冻结：此后不再接受新调用，耗时停止滚动。 */
        freeze(interrupted = false): void {
                this.interrupted = interrupted;
        }

        reset(): void {
                this.calls = [];
                this.turnEndedAt = undefined;
                this.interrupted = false;
                this.invalidators.clear();
        }

        setInvalidator(id: string, fn: () => void): void {
                this.invalidators.set(id, fn);
        }

        invalidateAll(): void {
                for (const fn of this.invalidators.values()) fn();
        }

        invalidateLast(): void {
                const last = this.calls[this.calls.length - 1];
                if (last) this.invalidators.get(last.id)?.();
        }

        /** 登记一次调用；新行加入时立刻把上一行降级（否则会多渲染一帧）。 */
        ensure(id: string, name: string): CallRec {
                const existing = this.calls.find((c) => c.id === id);
                if (existing) return existing;
                const prev = this.calls[this.calls.length - 1];
                const rec: CallRec = { id, name, target: "", result: "", isError: false };
                this.calls.push(rec);
                if (prev) this.invalidators.get(prev.id)?.();
                return rec;
        }

        isLast(id: string): boolean {
                return this.calls[this.calls.length - 1]?.id === id;
        }

        anyRunning(): boolean {
                // 回合已经结束却仍有调用没有结果 → 那是中断，不是还在跑
                if (this.interrupted) return false;
                return this.calls.some((c) => c.startedAt !== undefined && c.endedAt === undefined);
        }

        anyStarted(): boolean {
                return this.calls.some((c) => c.startedAt !== undefined);
        }

        doneCount(): number {
                return this.calls.filter((c) => c.endedAt !== undefined).length;
        }

        current(): CallRec | undefined {
                return this.calls.find((c) => c.startedAt !== undefined && c.endedAt === undefined);
        }

        failedCount(): number {
                return this.calls.filter((c) => c.isError).length;
        }
}

export function fmtMs(ms: number): string {
        if (ms < 0) ms = 0;
        if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
        return `${(ms / 1000).toFixed(1)}s`;
}

export function elapsedOf(batch: Batch, now: number): string {
        const first = batch.calls.find((c) => c.startedAt !== undefined);
        if (first?.startedAt === undefined) return "0.0s";
        const lastEnd = [...batch.calls].reverse().find((c) => c.endedAt !== undefined)?.endedAt;
        const end = batch.anyRunning() ? now : (batch.turnEndedAt ?? lastEnd ?? now);
        return fmtMs(end - first.startedAt);
}

export function distributionOf(calls: CallRec[]): string {
        const counts = new Map<string, number>();
        for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
        const parts = [...counts].map(([n, c]) => (c > 1 ? `${n}×${c}` : n));
        if (parts.length <= 3) return parts.join(" ");
        return `${parts.slice(0, 3).join(" ")} +${parts.length - 3}`;
}

function markerOf(batch: Batch, cfg: Config, frame: number, p: Palette): string {
        if (batch.anyRunning()) {
                const frames = cfg.markerStyle === "dot" ? DOTS : BRAILLE;
                return p.accent(frames[frame % frames.length]!);
        }
        if (batch.anyStarted()) return p.dim("⠿");
        return p.dim("⠿");
}

export interface SummaryOptions {
        cfg: Config;
        now: number;
        frame: number;
        /** 终端可用宽度（显示列）。 */
        width: number;
        p: Palette;
}

/**
 * 汇总行。按 §3.3 的降级阶梯逐级丢弃字段，保证始终 1 行。
 */
export function summaryLine(batch: Batch, opts: SummaryOptions): string {
        const { cfg, now, frame, width, p } = opts;
        const words = WORDS[cfg.labels];
        const total = batch.calls.length;
        if (total === 0) return "";

        const elapsed = elapsedOf(batch, now);
        const failed = batch.failedCount();
        const failSuffix = failed > 0 ? ` · ${p.error(`⚠${failed}`)}` : "";

        const levels: string[] = [];
        if (batch.anyRunning()) {
                const cur = batch.current();
                const what = cur ? `${cur.name}${cur.target ? ` ${cur.target}` : ""}` : "";
                const counter = `${batch.doneCount()}/${total}`;
                levels.push(`${markerOf(batch, cfg, frame, p)} ${p.accent(what)} · ${counter} · ${elapsed}`);
                levels.push(`${markerOf(batch, cfg, frame, p)} ${counter} · ${elapsed}`);
                levels.push(`${markerOf(batch, cfg, frame, p)} ${elapsed}`);
        } else if (!batch.anyStarted()) {
                levels.push(`${markerOf(batch, cfg, frame, p)} ${words.calls(total)} · ${p.muted(distributionOf(batch.calls))} · ${words.preparing}`);
                levels.push(`${markerOf(batch, cfg, frame, p)} ${words.calls(total)} · ${words.preparing}`);
                levels.push(`${markerOf(batch, cfg, frame, p)} ${words.preparing}`);
        } else if (batch.interrupted) {
                levels.push(`${p.warning("⊘")} ${words.calls(total)} · ${p.muted(distributionOf(batch.calls))} · ${elapsed} · ${words.interrupted}`);
                levels.push(`${p.warning("⊘")} ${words.calls(total)} · ${elapsed} · ${words.interrupted}`);
                levels.push(`${p.warning("⊘")} ${elapsed}`);
        } else {
                const head = p.dim("▸");
                levels.push(`${head} ${words.calls(total)} · ${p.muted(distributionOf(batch.calls))} · ${elapsed}${failSuffix}`);
                levels.push(`${head} ${words.calls(total)} · ${elapsed}${failSuffix}`);
                levels.push(`${head} ${elapsed}${failSuffix}`);
        }

        const fits = levels.find((l) => visible(l) <= width);
        return fits ?? levels[levels.length - 1]!;
}

/** 详情行：每条调用 1 行。 */
export function detailLines(batch: Batch, opts: { cfg: Config; p: Palette }): string[] {
        const { cfg, p } = opts;
        const shown = batch.calls.slice(0, cfg.maxDetailLines);
        const lines = shown.map((c, i) => {
                const branch = i === shown.length - 1 && shown.length === batch.calls.length ? "└" : "├";
                const dur = c.durationMs !== undefined ? ` · ${fmtMs(c.durationMs)}` : "";
                const err = c.isError ? p.error(" ⚠") : "";
                const parts = [`  ${p.dim(branch)} ${p.bold(c.name)}`, c.target ? p.accent(c.target) : "", c.result ? p.muted(c.result) : ""]
                        .filter(Boolean)
                        .join("  ");
                return `${parts}${p.muted(dur)}${err}`;
        });
        if (batch.calls.length > shown.length) {
                lines.push(`  ${p.dim("└")} ${p.muted(`… +${batch.calls.length - shown.length} more`)}`);
        }
        return lines;
}

/** 去掉 ANSI 后的显示宽度（不引入 pi-tui，保证本模块可独立单测）。 */
function visible(s: string): number {
        // eslint-disable-next-line no-control-regex
        const plain = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
        let w = 0;
        for (const ch of plain) {
                const cp = ch.codePointAt(0)!;
                w += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) ? 2 : 1;
        }
        return w;
}
