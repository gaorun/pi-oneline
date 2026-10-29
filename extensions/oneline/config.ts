import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Mode = "off" | "row" | "group";
export type Labels = "en" | "zh";
export type MarkerStyle = "braille" | "dot";

export interface Config {
        mode: Mode;
        labels: Labels;
        markerStyle: MarkerStyle;
        maxDetailLines: number;
        shortcut: string;
        hideThinking: boolean;
        /** `/oneline setup` 改写 `hideThinkingBlock` 之前的值，`/oneline reset` 用它还原。 */
        hideThinkingBackup?: boolean | null;
}

export const DEFAULTS: Config = {
        mode: "group",
        labels: "en",
        markerStyle: "braille",
        maxDetailLines: 12,
        shortcut: "alt+t",
        hideThinking: true,
        hideThinkingBackup: null,
};

export const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "pi-oneline.json");
export const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

const MODES: Mode[] = ["off", "row", "group"];

/** 读配置；任何非法值都退回默认值，不抛错（配置文件是给人手写的）。 */
function readRaw(): Record<string, unknown> {
        try {
                const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
                return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
                return {};
        }
}

export function loadConfig(): Config {
        const raw = readRaw();
        const cfg: Config = { ...DEFAULTS };
        if (MODES.includes(raw.mode as Mode)) cfg.mode = raw.mode as Mode;
        if (raw.labels === "en" || raw.labels === "zh") cfg.labels = raw.labels;
        if (raw.markerStyle === "braille" || raw.markerStyle === "dot") cfg.markerStyle = raw.markerStyle;
        if (typeof raw.maxDetailLines === "number" && raw.maxDetailLines > 0) cfg.maxDetailLines = Math.floor(raw.maxDetailLines);
        if (typeof raw.shortcut === "string") cfg.shortcut = raw.shortcut;
        if (typeof raw.hideThinking === "boolean") cfg.hideThinking = raw.hideThinking;
        if (typeof raw.hideThinkingBackup === "boolean" || raw.hideThinkingBackup === null) {
                cfg.hideThinkingBackup = raw.hideThinkingBackup;
        }
        // 临时覆盖（集成测试、演示），不写回文件
        const envMode = process.env.PI_ONELINE_MODE as Mode | undefined;
        if (envMode && MODES.includes(envMode)) cfg.mode = envMode;
        return cfg;
}

export function saveConfig(cfg: Config): void {
        writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}
