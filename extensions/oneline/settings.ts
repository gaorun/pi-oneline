/**
 * `hideThinkingBlock` 只能通过设置文件生效：pi 在启动时把它读进内存，
 * 扩展没有运行时修改它的 API，只有 `session.reload()`（`/reload`）会重读文件。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SETTINGS_PATH } from "./config.ts";

interface SettingsFile {
        [key: string]: unknown;
}

function read(): SettingsFile {
        try {
                const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
                return parsed && typeof parsed === "object" ? (parsed as SettingsFile) : {};
        } catch {
                return {};
        }
}

export function getHideThinkingBlock(): boolean | undefined {
        const value = read().hideThinkingBlock;
        return typeof value === "boolean" ? value : undefined;
}

/** 移除该键（原本就没有设置时，还原应当删除而不是写 false）。 */
export function unsetHideThinkingBlock(): boolean {
        const settings = read();
        if (!("hideThinkingBlock" in settings)) return false;
        delete settings.hideThinkingBlock;
        writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
        return true;
}

/** 写入并返回是否真的改动了文件。 */
export function setHideThinkingBlock(value: boolean): boolean {
        const settings = read();
        if (settings.hideThinkingBlock === value) return false;
        settings.hideThinkingBlock = value;
        writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
        return true;
}
