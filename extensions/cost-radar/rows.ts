/**
 * 归账解析：subagent 工具结果 details → 账本行（设计 §7.1）
 *
 * 三重判据（toolName==="subagent" && details.costContract===1 && results 数组）+ usage 四维校验；
 * 只浅读 .results[].usage/.provider/.model/.endedAt/.cwd，禁止深遍历（C6）。
 * 任一不满足 → 该条（或整体）不计，绝不猜测（C1/C2）。
 */

import { normalizeModelId } from "./adapters/types";
import path from "node:path";
import type { LedgerRow, UsageTotals } from "./core";

interface ToolResultLike {
  toolName?: string;
  details?: unknown;
}

function num4(u: unknown): UsageTotals | null {
  if (!u || typeof u !== "object") return null;
  const x = u as Record<string, unknown>;
  const dims = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const d of dims) {
    const v = x[d];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    out[d] = v;
  }
  return out;
}

export function subagentRows(message: ToolResultLike, entryTsMs: number): LedgerRow[] {
  if (message.toolName !== "subagent") return [];
  const d = message.details as { costContract?: unknown; results?: unknown } | undefined;
  if (!d || d.costContract !== 1 || !Array.isArray(d.results)) return [];

  const rows: LedgerRow[] = [];
  for (const r of d.results) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const provider = rec.provider;
    const model = rec.model;
    if (typeof provider !== "string" || provider.length === 0) continue;
    if (typeof model !== "string" || model.length === 0) continue;
    const usage = num4(rec.usage);
    if (!usage) continue;
    const endedAt = rec.endedAt;
    const tsMs = typeof endedAt === "number" && Number.isFinite(endedAt) ? endedAt : entryTsMs;
    rows.push({ modelKey: `${provider}/${normalizeModelId(model)}`, usage, tsMs, subagent: true });
  }
  return rows;
}

/**
 * 统计「跨 cwd 未纳入共享闸门」的 result 条数。
 *
 * cost-radar 的闸门 bus.check(cwd) 仅在 cwd 与父会话一致时返回生效额度，
 * 跨 cwd 子代理（tasks[].cwd 指向其它目录）不受闸门限制——面板据此提示。
 * 判据：result.cwd 为非空字符串，且路径归一后 !== 父会话 cwd。老版本无 cwd 字段
 * （undefined）/ 非法类型 / 空串 → 不计数（保守，绝不猜测）。
 *
 * 路径归一取舍：用纯函数 path.resolve 归一（相对→绝对、折叠
 * `.`/`..`、去尾分隔符），避免 `/a/../parent` 与 `/parent`、`/parent/` 等「同一目录
 * 不同字面量」被误计为跨 cwd。不用 fs.realpath 是刻意取舍：本判据仅驱动 UI 提示
 * （只提示不误拦），realpath 会引入同步 IO 且对不存在路径抛错；符号链接别名仍可能
 * 漏判，属已知近似（同一 inode 经不同链接路径不计为跨 cwd）。
 */
export function crossCwdCount(message: ToolResultLike, parentCwd: string): number {
  const d = message.details as { costContract?: unknown; results?: unknown } | undefined;
  if (!d || d.costContract !== 1 || !Array.isArray(d.results)) return 0;
  const normalizedParent = path.resolve(parentCwd);
  let n = 0;
  for (const r of d.results) {
    if (!r || typeof r !== "object") continue;
    const cwd = (r as Record<string, unknown>).cwd;
    if (typeof cwd !== "string" || cwd.length === 0) continue;
    if (path.resolve(cwd) !== normalizedParent) n++;
  }
  return n;
}

/**
 * 统计「有正用量但缺 provider」的 result 条数（旧版 pi-subagent 检测；面板常驻提示 + 一次性 notify 共用）。
 * 不要求 costContract===1：旧版 pi-subagent 恰恰没有该标记，以「有正用量但无 provider」为判据；
 * 零用量/拒启条目不计数（拒启 ≠ 缺 provider）。
 */
export function missingProviderCount(message: ToolResultLike): number {
  const d = message.details as { results?: unknown } | undefined;
  if (!d || !Array.isArray(d.results)) return 0;
  let n = 0;
  for (const r of d.results) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const provider = rec.provider;
    if (typeof provider === "string" && provider.length > 0) continue; // 有 provider → 不算缺
    const usage = num4(rec.usage);
    if (!usage) continue;
    if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) n++;
  }
  return n;
}
