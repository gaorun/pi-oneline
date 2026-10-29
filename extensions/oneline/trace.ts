/**
 * 渲染决策追踪：设置 PI_ONELINE_DEBUG=/path/to.jsonl 时逐条记录。
 * 仅供诊断与集成测试使用，平时零开销。
 */
import { appendFileSync } from "node:fs";

const target = process.env.PI_ONELINE_DEBUG;

export const tracing = Boolean(target);

export function trace(event: Record<string, unknown>): void {
        if (!target) return;
        try {
                appendFileSync(target, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
        } catch {
                /* 追踪失败不影响渲染 */
        }
}
