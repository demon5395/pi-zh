/**
 * 计价核心（从 index.ts 抽出，供 index.ts 账本与 budget.ts 闸门共用）
 *
 * 单一计价口径：闸门（budget.ts）与账本（index.ts/aggregateLedger）必须调用同一函数，
 * 否则「实时判定」与「最终账本」会漂移。切莫在别处再造一份计价。
 */

import type { ModelAdapter } from "./adapters/types";
import type { Registry } from "./adapters/registry";
import type { UsageTotals } from "./core";

/** key("provider/model") → registry 适配器（key 为账本/覆盖寻址键） */
export function adapterOf(reg: Registry, key: string): ModelAdapter | null {
  const i = key.indexOf("/");
  if (i <= 0 || i === key.length - 1) return null;
  return reg.lookup(key.slice(0, i), key.slice(i + 1));
}

/** 账本聚合所需的 costOf/coveredOf（core 注入解耦）：coveredOf=是否收录；costOf 仅收录后调用，返回 ¥ */
export function makeCostFns(reg: Registry): {
  coveredOf: (key: string) => boolean;
  costOf: (key: string, u: UsageTotals, tsMs: number) => number | null;
} {
  return {
    coveredOf: (key: string) => adapterOf(reg, key) !== null,
    costOf: (key: string, u: UsageTotals, tsMs: number) => adapterOf(reg, key)?.cost(u, tsMs) ?? null,
  };
}
