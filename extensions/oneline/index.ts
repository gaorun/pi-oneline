/**
 * pi-oneline：把同一批工具调用折成一行摘要。
 *
 * - `group`：整批占 1 行（除末行外其余行渲染 0 高度），展开时明细画在同一行下方
 * - `row`：每次调用 1 行（纯公开 API，作为 group 的降级形态）
 * - `off`：完全交给 pi 原生渲染
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Batch } from "./batch.ts";
import { CONFIG_PATH, loadConfig, saveConfig, type Config } from "./config.ts";
import { makeRenderers } from "./render.ts";
import { getHideThinkingBlock, setHideThinkingBlock, unsetHideThinkingBlock } from "./settings.ts";
import { trace } from "./trace.ts";

export default function (pi: ExtensionAPI) {
        let cfg: Config = loadConfig();
        const batch = new Batch();

        let frame = 0;
        let timer: ReturnType<typeof setInterval> | undefined;
        let degraded = false;
        let hitCount = 0;
        let warnedDegrade = false;
        let warnedThinking = false;
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
                if (timer || mode() === "off" || !batch.anyRunning()) return;
                timer = setInterval(() => {
                        frame += 1;
                        batch.invalidateLast();
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
                batch.invalidateAll();
                if (!warnedDegrade) {
                        warnedDegrade = true;
                        notify(`pi-oneline: 渲染异常，已退回 row 模式（${String(error)}）`, "warning");
                }
        }

        pi.registerToolRenderer((toolName, next) => {
                const base = next();
                if (mode() === "off") return base;
                const ours = makeRenderers(toolName, {
                        batch,
                        cfg: () => cfg,
                        mode,
                        expanded: () => forcedExpand,
                        frame: () => frame,
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
                batch.reset();
                degraded = false;
                hitCount = 0;
                forcedExpand = false;
                stopTimer();
                refreshStatus();

                if (cfg.hideThinking && getHideThinkingBlock() !== true && !warnedThinking) {
                        warnedThinking = true;
                        notify("pi-oneline: 思考块尚未折叠，运行 /oneline setup 生效（需要重载）", "info");
                }
        });

        pi.on("session_shutdown", async () => {
                stopTimer();
        });

        pi.on("agent_start", async () => {
                batch.reset();
                hitCount = 0;
                frame = 0;
                stopTimer();
        });

        // 一批调用的顺序必须在组件渲染之前就知道，否则会出现"先出现后消失"的一帧
        const preregister = (message: any) => {
                if (message?.role !== "assistant") return;
                for (const content of message.content ?? []) {
                        if (content?.type === "toolCall") batch.ensure(content.id, content.name);
                }
        };

        pi.on("message_start", async (event: any) => preregister(event.message));
        pi.on("message_update", async (event: any) => preregister(event.message));

        pi.on("tool_execution_start", async (event: any) => {
                if (event.parentToolCallId) return;
                const rec = batch.ensure(event.toolCallId, event.toolName);
                rec.startedAt = Date.now();
                trace({ ev: "start", id: event.toolCallId, name: event.toolName });
                ensureTimer();
        });

        pi.on("tool_execution_end", async (event: any) => {
                if (event.parentToolCallId) return;
                const rec = batch.ensure(event.toolCallId, event.toolName);
                rec.endedAt = Date.now();
                if (event.isError) rec.isError = true;
                if (typeof event.durationMs === "number") rec.durationMs = event.durationMs;
                trace({ ev: "end", id: event.toolCallId, isError: !!event.isError });
                if (!batch.anyRunning()) stopTimer();
                batch.invalidateAll();
        });

        pi.on("turn_end", async () => {
                // 耗时量到回合结束（含模型侧收尾），与设计 §3.2 一致
                if (batch.anyRunning()) return;
                batch.turnEndedAt = Date.now();
                stopTimer();
                batch.invalidateAll();
        });

        pi.on("agent_end", async () => {
                if (batch.calls.some((c) => c.startedAt !== undefined && c.endedAt === undefined)) batch.interrupted = true;
                stopTimer();
                batch.invalidateAll();
                trace({ ev: "agent_end", ids: batch.calls.map((c) => c.id), calls: batch.calls.length, interrupted: batch.interrupted });
                if (batch.calls.length > 0 && hitCount === 0) degrade("工具渲染器未被调用");
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
                                        batch.invalidateAll();
                                },
                        });
                } catch {
                        /* 非法键位不影响其余功能 */
                }
        }

        pi.registerCommand("oneline", {
                description: "pi-oneline：off | row | group | setup | reset | toggle | info",
                handler: async (args, ctx) => {
                        ui = ctx.ui;
                        const sub = args.trim().toLowerCase();

                        if (!sub || sub === "info") {
                                const current = getHideThinkingBlock();
                                ctx.ui.notify(
                                        [
                                                `模式：${mode()}${degraded ? "（已降级）" : ""}`,
                                                `标签：${cfg.labels} · 标记：${cfg.markerStyle}`,
                                                `hideThinkingBlock：${current === undefined ? "未设置" : current}，备份：${cfg.hideThinkingBackup ?? "无"}`,
                                                `配置：${CONFIG_PATH}`,
                                                `本回合调用：${batch.calls.length}`,
                                        ].join("\n"),
                                        "info",
                                );
                                return;
                        }

                        if (sub === "off" || sub === "row" || sub === "group") {
                                cfg.mode = sub;
                                saveConfig(cfg);
                                batch.invalidateAll();
                                refreshStatus();
                                ctx.ui.notify(`pi-oneline 模式：${cfg.mode}（对新组件生效）`, "info");
                                return;
                        }

                        if (sub === "toggle") {
                                forcedExpand = !forcedExpand;
                                batch.invalidateAll();
                                return;
                        }

                        if (sub === "setup") {
                                const before = getHideThinkingBlock();
                                cfg.hideThinkingBackup = before ?? null;
                                saveConfig(cfg);
                                const changed = setHideThinkingBlock(true);
                                ctx.ui.notify(changed ? "已写入 hideThinkingBlock=true，重载后生效" : "hideThinkingBlock 已是 true", "info");
                                await ctx.reload();
                                return;
                        }

                        if (sub === "reset") {
                                const backup = cfg.hideThinkingBackup;
                                cfg.hideThinkingBackup = null;
                                saveConfig(cfg);
                                const changed = backup === null || backup === undefined ? unsetHideThinkingBlock() : setHideThinkingBlock(backup);
                                const what = backup === null || backup === undefined ? "移除 hideThinkingBlock" : `还原 hideThinkingBlock=${backup}`;
                                ctx.ui.notify(changed ? `已${what}，重载后生效` : "无需还原", "info");
                                await ctx.reload();
                                return;
                        }

                        ctx.ui.notify("用法：/oneline [off|row|group|setup|reset|toggle|info]", "warning");
                },
        });
}
