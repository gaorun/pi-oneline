/**
 * pi-oneline：把同一批工具调用折成一行摘要。
 *
 * - `group`：整批占 1 行（除末行外其余行渲染 0 高度），展开时明细画在同一行下方
 * - `row`：每次调用 1 行（纯公开 API，作为 group 的降级形态）
 * - `off`：完全交给 pi 原生渲染
 *
 * 每轮对话是一个独立批次：回合结束即冻结，旧回合的汇总不会跟着新回合变化。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Batch } from "./batch.ts";
import { CONFIG_PATH, loadConfig, saveConfig, type Config } from "./config.ts";
import { makeRenderers, type RowContext } from "./render.ts";
import { trace } from "./trace.ts";

export default function (pi: ExtensionAPI) {
        let cfg: Config = loadConfig();

        /** 当前进行中的批次；回合结束后置空，但批次本身仍被它自己的行引用。 */
        let live: Batch | undefined;
        /** 所有还活着的批次（历史行重建时需要读它们）。 */
        const batches = new Map<number, Batch>();
        /** toolCallId → 它所属的批次。 */
        const owner = new Map<string, Batch>();

        let frame = 0;
        let timer: ReturnType<typeof setInterval> | undefined;
        let degraded = false;
        let hitCount = 0;
        let warnedDegrade = false;
        let forcedExpand = false;
        let ui: any;

        const mode = (): "off" | "row" | "group" => (degraded ? "row" : cfg.mode);

        function notify(message: string, type: "info" | "warning" | "error" = "info"): void {
                try {
                        ui?.notify(message, type);
                } catch {
                        /* 通知失败不影响渲染 */
                }
        }

        function stopTimer(): void {
                if (timer) {
                        clearInterval(timer);
                        timer = undefined;
                }
        }

        function ensureTimer(): void {
                if (timer || mode() === "off" || !live?.anyRunning()) return;
                timer = setInterval(() => {
                        frame += 1;
                        live?.invalidateLast();
                }, 90);
        }

        function refreshStatus(): void {
                if (!ui) return;
                const current = mode();
                ui.setStatus("oneline", current === "group" ? undefined : ui.theme.fg("dim", `oneline: ${current}`));
        }

        /** 渲染器内部任何异常都退回 row 模式，宁可退化也不让转录变空。 */
        function degrade(error: unknown): void {
                if (degraded) return;
                degraded = true;
                stopTimer();
                for (const batch of batches.values()) batch.invalidateAll();
                if (!warnedDegrade) {
                        warnedDegrade = true;
                        notify(`pi-oneline: 渲染异常，已退回 row 模式（${String(error)}）`, "warning");
                }
        }

        function openBatch(): Batch {
                const batch = new Batch();
                batches.set(batch.id, batch);
                live = batch;
                return batch;
        }

        /**
         * 把一次调用归属到它的批次。
         * - 已归属：返回原批次（可能已冻结）
         * - 未知且存在进行中的回合：归入当前批次
         * - 未知且没有进行中的回合：历史转录（如 /resume 重建），返回 undefined
         */
        function resolveRow(toolCallId: string, toolName: string): RowContext | undefined {
                const known = owner.get(toolCallId);
                if (known) return { batch: known, rec: known.ensure(toolCallId, toolName), live: known === live };
                if (!live) return undefined;
                const rec = live.ensure(toolCallId, toolName);
                owner.set(toolCallId, live);
                return { batch: live, rec, live: true };
        }

        pi.registerToolRenderer((toolName, next) => {
                const base = next();
                if (mode() === "off") return base;
                const ours = makeRenderers(toolName, {
                        cfg: () => cfg,
                        mode,
                        expanded: () => forcedExpand,
                        frame: () => frame,
                        resolveRow,
                        hit: () => {
                                hitCount += 1;
                        },
                        onError: degrade,
                });
                return base ? { ...base, ...ours } : ours;
        });

        pi.on("session_start", async (_event, ctx) => {
                ui = ctx.ui;
                cfg = loadConfig();
                batches.clear();
                owner.clear();
                live = undefined;
                degraded = false;
                hitCount = 0;
                forcedExpand = false;
                stopTimer();
                refreshStatus();
        });

        pi.on("session_shutdown", async () => {
                stopTimer();
        });

        pi.on("agent_start", async () => {
                openBatch();
                hitCount = 0;
                frame = 0;
                stopTimer();
        });

        // 一批调用的顺序必须在组件渲染之前就知道，否则会出现"先出现后消失"的一帧
        const preregister = (message: any) => {
                if (message?.role !== "assistant" || !live) return;
                for (const content of message.content ?? []) {
                        if (content?.type === "toolCall") {
                                live.ensure(content.id, content.name);
                                owner.set(content.id, live);
                        }
                }
        };

        pi.on("message_start", async (event: any) => preregister(event.message));
        pi.on("message_update", async (event: any) => preregister(event.message));

        pi.on("tool_execution_start", async (event: any) => {
                if (event.parentToolCallId || !live) return;
                const rec = live.ensure(event.toolCallId, event.toolName);
                owner.set(event.toolCallId, live);
                rec.startedAt = Date.now();
                trace({ ev: "start", id: event.toolCallId, name: event.toolName, batch: live.id });
                ensureTimer();
        });

        pi.on("tool_execution_end", async (event: any) => {
                if (event.parentToolCallId) return;
                const batch = owner.get(event.toolCallId);
                if (!batch) return;
                const rec = batch.ensure(event.toolCallId, event.toolName);
                rec.endedAt = Date.now();
                if (event.isError) rec.isError = true;
                if (typeof event.durationMs === "number") rec.durationMs = event.durationMs;
                trace({ ev: "end", id: event.toolCallId, isError: !!event.isError, batch: batch.id });
                if (!batch.anyRunning()) stopTimer();
                batch.invalidateAll();
        });

        pi.on("turn_end", async () => {
                // 耗时量到回合结束（含模型侧收尾），与设计 §3.2 一致
                if (!live || live.anyRunning()) return;
                live.turnEndedAt = Date.now();
                stopTimer();
                live.invalidateAll();
        });

        pi.on("agent_end", async () => {
                const finished = live;
                if (!finished) return;
                const unfinished = finished.calls.some((c) => c.startedAt !== undefined && c.endedAt === undefined);
                finished.freeze(unfinished);
                trace({ ev: "agent_end", batch: finished.id, ids: finished.calls.map((c) => c.id), calls: finished.calls.length, interrupted: unfinished });
                stopTimer();
                finished.invalidateAll();
                // 冻结之后，这一轮的行仍然只读自己的批次；新的回合会开新批次
                live = undefined;
                if (finished.calls.length > 0 && hitCount === 0) degrade("工具渲染器未被调用");
        });

        pi.on("agent_settled", async (_event, ctx) => {
                ui = ctx.ui;
        });

        if (cfg.shortcut) {
                try {
                        pi.registerShortcut(cfg.shortcut as any, {
                                description: "切换 pi-oneline 的明细视图",
                                handler: async () => {
                                        forcedExpand = !forcedExpand;
                                        for (const batch of batches.values()) batch.invalidateAll();
                                },
                        });
                } catch {
                        /* 非法键位不影响其余功能 */
                }
        }

        pi.registerCommand("oneline", {
                description: "pi-oneline：off | row | group | toggle | info",
                handler: async (args, ctx) => {
                        ui = ctx.ui;
                        const sub = args.trim().toLowerCase();

                        if (!sub || sub === "info") {
                                ctx.ui.notify(
                                        [
                                                `模式：${mode()}${degraded ? "（已降级）" : ""}`,
                                                `标签：${cfg.labels} · 标记：${cfg.markerStyle}`,
                                                `配置：${CONFIG_PATH}`,
                                                `本回合调用：${live?.calls.length ?? 0} · 会话内批次：${batches.size}`,
                                        ].join("\n"),
                                        "info",
                                );
                                return;
                        }

                        if (sub === "off" || sub === "row" || sub === "group") {
                                cfg.mode = sub;
                                saveConfig(cfg);
                                for (const batch of batches.values()) batch.invalidateAll();
                                refreshStatus();
                                ctx.ui.notify(`pi-oneline 模式：${cfg.mode}（对新组件生效）`, "info");
                                return;
                        }

                        if (sub === "toggle") {
                                forcedExpand = !forcedExpand;
                                for (const batch of batches.values()) batch.invalidateAll();
                                return;
                        }

                        ctx.ui.notify("用法：/oneline [off|row|group|toggle|info]", "warning");
                },
        });
}
