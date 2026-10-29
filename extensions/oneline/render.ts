/**
 * 工具渲染器：把工具调用画成折叠行（group）或每条一行（row）。
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Batch, Palette } from "./batch.ts";
import { detailLines, summaryLine } from "./batch.ts";
import type { Config } from "./config.ts";
import { trace } from "./trace.ts";

/** 尺寸无关的懒渲染组件：宽度在 render 时才可知，所以文案在这里才拼。 */
export class Line implements Component {
        constructor(private readonly build: (width: number) => string[]) {}

        render(width: number): string[] {
                try {
                        return this.build(width);
                } catch {
                        return [];
                }
        }

        invalidate(): void {}
}

export interface RenderDeps {
        batch: Batch;
        cfg: () => Config;
        mode: () => "off" | "row" | "group";
        expanded: () => boolean;
        frame: () => number;
        hit: () => void;
        onError: (error: unknown) => void;
}

export function paletteOf(theme: any): Palette {
        return {
                dim: (s) => theme.fg("dim", s),
                muted: (s) => theme.fg("muted", s),
                accent: (s) => theme.fg("accent", s),
                warning: (s) => theme.fg("warning", s),
                error: (s) => theme.fg("error", s),
                bold: (s) => theme.bold(s),
        };
}

/** 参数摘要：一行内说明这次调用干了什么。 */
export function describeArgs(toolName: string, args: any): string {
        const first = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
        switch (toolName) {
                case "bash":
                        return short(first(args?.command));
                case "read":
                case "edit":
                case "write":
                        return short(first(args?.path));
                case "grep":
                case "find":
                        return short(first(args?.pattern));
                case "ls":
                        return short(first(args?.path));
                default: {
                        const rec = args && typeof args === "object" ? Object.values(args).find((v) => typeof v === "string") : undefined;
                        return short(first(rec) || first(args?.path) || first(args?.name));
                }
        }
}

function short(s: string, max = 48): string {
        if (!s) return "";
        const line = s.split("\n")[0]!;
        return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 结果摘要：折叠态不显示原文，只显示可判断的结论。 */
export function describeResult(toolName: string, result: any): string {
        const text = (result?.content ?? []).find((c: any) => c?.type === "text")?.text ?? "";
        const lines = text.trim() ? text.trim().split("\n") : [];
        const details = result?.details ?? {};
        switch (toolName) {
                case "read":
                        return details?.truncation?.truncated ? `${lines.length} lines (truncated)` : `${lines.length} lines`;
                case "write":
                        return `${lines.length} lines`;
                case "edit": {
                        const diff = typeof details?.diff === "string" ? details.diff : text;
                        const add = diff.split("\n").filter((l: string) => l.startsWith("+") && !l.startsWith("+++")).length;
                        const del = diff.split("\n").filter((l: string) => l.startsWith("-") && !l.startsWith("---")).length;
                        return add || del ? `+${add} −${del}` : "applied";
                }
                case "bash": {
                        const m = text.match(/exit code: (\d+)/);
                        if (m) return Number(m[1]) === 0 ? "exit 0" : `exit ${m[1]}`;
                        return `${lines.length} lines`;
                }
                case "grep":
                        return `${lines.length} matches`;
                case "find":
                case "ls":
                        return `${lines.length} entries`;
                default:
                        return result?.isError ? "error" : "ok";
        }
}

export interface BuiltRenderers {
        renderShell: "self";
        renderCall: (args: any, theme: any, ctx: any) => Component;
        renderResult: (result: any, opts: any, theme: any, ctx: any) => Component;
}

export function makeRenderers(toolName: string, deps: RenderDeps): BuiltRenderers {
        const pad = (ctx: any) => " ".repeat(Math.max(0, ctx?.outputPad ?? 1));

        return {
                renderShell: "self",

                renderCall(args: any, theme: any, ctx: any) {
                        deps.hit();
                        try {
                                const batch = deps.batch;
                                const rec = batch.ensure(ctx.toolCallId, toolName);
                                rec.target = describeArgs(toolName, args);
                                batch.setInvalidator(ctx.toolCallId, ctx.invalidate);

                                const indent = pad(ctx);

                                if (deps.mode() === "row") {
                                        trace({ ev: "render-call", id: ctx.toolCallId, isLast: batch.isLast(ctx.toolCallId), lines: 1, mode: "row" });
                                        return new Line((width) => {
                                                const p = paletteOf(theme);
                                                const text = `${p.bold(toolName)}${rec.target ? ` ${p.accent(rec.target)}` : ""}`;
                                                return [truncateToWidth(indent + text, width)];
                                        });
                                }

                                const isLast = batch.isLast(ctx.toolCallId);
                                if (!isLast) {
                                        trace({ ev: "render-call", id: ctx.toolCallId, isLast, lines: 0, mode: "group" });
                                        return new Line(() => []);
                                }

                                return new Line((width) => {
                                        const p = paletteOf(theme);
                                        const cfg = deps.cfg();
                                        const line = summaryLine(batch, { cfg, now: Date.now(), frame: deps.frame(), width: width - indent.length, p });
                                        trace({ ev: "render-call", id: ctx.toolCallId, isLast, lines: line ? 1 : 0, mode: "group", text: strip(line) });
                                        return line ? [truncateToWidth(indent + line, width)] : [];
                                });
                        } catch (error) {
                                deps.onError(error);
                                return new Line(() => []);
                        }
                },

                renderResult(result: any, opts: any, theme: any, ctx: any) {
                        deps.hit();
                        try {
                                const batch = deps.batch;
                                const rec = batch.ensure(ctx.toolCallId, toolName);
                                rec.result = describeResult(toolName, result);
                                if (opts?.isError || result?.isError) rec.isError = true;
                                if (typeof ctx?.durationMs === "number") rec.durationMs = ctx.durationMs;
                                batch.setInvalidator(ctx.toolCallId, ctx.invalidate);

                                const expanded = !!(opts?.expanded || deps.expanded());
                                const indent = pad(ctx);
                                const cfg = deps.cfg();

                                if (deps.mode() === "row") {
                                        if (!expanded) {
                                                trace({ ev: "render-result", id: ctx.toolCallId, lines: 0, mode: "row" });
                                                return new Line(() => []);
                                        }
                                        const text = (result?.content ?? []).find((c: any) => c?.type === "text")?.text ?? "";
                                        const preview = text.trim().split("\n").slice(0, cfg.maxDetailLines);
                                        trace({ ev: "render-result", id: ctx.toolCallId, lines: preview.length, mode: "row" });
                                        return new Line((width) => preview.map((l: string) => truncateToWidth(`${indent}${paletteOf(theme).muted(l)}`, width)));
                                }

                                if (!batch.isLast(ctx.toolCallId) || !expanded) {
                                        trace({ ev: "render-result", id: ctx.toolCallId, lines: 0, mode: "group" });
                                        return new Line(() => []);
                                }

                                return new Line((width) => {
                                        const p = paletteOf(theme);
                                        const lines = detailLines(batch, { cfg, p });
                                        trace({ ev: "render-result", id: ctx.toolCallId, lines: lines.length, mode: "group" });
                                        return lines.map((l) => truncateToWidth(indent + l, width));
                                });
                        } catch (error) {
                                deps.onError(error);
                                return new Line(() => []);
                        }
                },
        };
}

/** 去掉 ANSI，便于追踪日志直接比较文案。 */
function strip(s: string): string {
        // eslint-disable-next-line no-control-regex
        return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}
