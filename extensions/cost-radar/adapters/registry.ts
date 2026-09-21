/**
 * 计价器注册表（adapters/registry.ts）
 *
 * 层依赖：registry → family 文件 + types（不 import core/index/config）。
 * 汇总 ALL_ROWS；buildRegistry(usdRate, overrides) 深合并覆盖后逐行 build，
 * 产出 {lookup(provider, modelId)}；lookup = matchRow（前缀长优先，未收录 → null）。
 * USD 行 build 时乘 usdRate；CNY 行忽略 usdRate 仍返回 ¥。
 */
import { ANTHROPIC_ROWS } from "./anthropic";
import { DEEPSEEK_ROWS } from "./deepseek";
import { MOONSHOT_ROWS } from "./moonshot";
import { OPENAI_ROWS } from "./openai";
import { QWEN_ROWS } from "./qwen";
import type { ModelAdapter, ParamValue, RowSpec } from "./types";
import { matchRow, mergeParamsDeep } from "./types";

/** 内置计价行汇总（任务 2/3/4 追加 family 行；任务 4 收录 moonshot/qwen，glm 见 PENDING.md） */
export const ALL_ROWS: RowSpec[] = [...DEEPSEEK_ROWS, ...ANTHROPIC_ROWS, ...OPENAI_ROWS, ...MOONSHOT_ROWS, ...QWEN_ROWS];

/** 覆盖表：key = RowSpec.key → 该行 schema 内字段的深合并覆盖值 */
export type PriceOverrides = Record<string, Record<string, ParamValue>>;

export interface Registry {
  /** 前缀长优先命中计价行并返回其适配器；未收录（供应商/模型不在清单）返回 null */
  lookup(provider: string, modelId: string): ModelAdapter | null;
}

/** 内置计价行元数据（浅拷贝，含 defaults/schema/currency…）：供 config 覆盖白名单与 /cost 单价页遍历 */
export function listRows(): RowSpec[] {
  return [...ALL_ROWS];
}

export function buildRegistry(usdRate: number, overrides: PriceOverrides = {}): Registry {
  const byKey = new Map<string, ModelAdapter>();
  for (const row of ALL_ROWS) {
    const params = mergeParamsDeep(row.defaults, overrides[row.key] ?? null);
    byKey.set(row.key, row.build(params, row.currency === "usd" ? usdRate : 1));
  }
  return {
    lookup(provider: string, modelId: string): ModelAdapter | null {
      const row = matchRow(ALL_ROWS, provider, modelId);
      return row ? byKey.get(row.key) ?? null : null;
    },
  };
}
