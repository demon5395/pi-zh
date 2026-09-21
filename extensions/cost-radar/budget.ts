/**
 * 额度闸门发布端（设计 §5）——只读、无副作用。
 *
 * 账本与额度判定由 cost-radar 拥有；pi-subagent 只经 check/price 读取。
 * price 必须复用 pricing.makeCostFns（单一计价口径），且带 tsMs（谷时取价）。
 * check 只回读生效额度与父 spend 快照，不修改任何状态（C5）。
 */

import type { Registry } from "./adapters/registry";
import { makeCostFns } from "./pricing";
import type { UsageTotals } from "./core";

export const BUDGET_BUS_KEY = "__piCostRadarBudget";

export interface CostRadarBudget {
  readonly version: 2;
  readonly ownerSessionId: string;
  /**
   * 发布该总线的扩展实例唯一标识。
   * uninstall 仅清理 instanceId 匹配的总线：即使未来 pi SDK 把 session_shutdown
   * 排到 session_start 之后（反序），同会话旧实例的 shutdown 也不会误删新 bus。
   */
  readonly instanceId: string;
  readonly cwd: string;
  check(cwd: string): { limit: number | null; parentSpend: number };
  price(
    provider: string,
    model: string,
    usage: UsageTotals,
    tsMs: number,
  ): { yuan: number | null; covered: boolean };
}

export interface BudgetDeps {
  ownerSessionId: string;
  /** 扩展实例唯一标识（见 CostRadarBudget.instanceId） */
  instanceId: string;
  cwd: string;
  /** 生效额度 ¥（sessionBudget ?? defaultBudget）；null = 闸门未启用 */
  getLimit(): number | null;
  /** 父会话已落盘 spend 快照（含此前 subagent details） */
  getParentSpend(): number;
  /** 调用时构建的当前 registry（配置改动即时生效） */
  getRegistry(): Registry;
}

export function createBudget(deps: BudgetDeps): CostRadarBudget {
  return {
    version: 2,
    ownerSessionId: deps.ownerSessionId,
    instanceId: deps.instanceId,
    cwd: deps.cwd,
    check(cwd) {
      if (cwd !== deps.cwd) return { limit: null, parentSpend: 0 };
      return { limit: deps.getLimit(), parentSpend: deps.getParentSpend() };
    },
    price(provider, model, usage, tsMs) {
      const { costOf } = makeCostFns(deps.getRegistry());
      const key = `${provider}/${model}`;
      const yuan = costOf(key, usage, tsMs);
      return { yuan, covered: yuan !== null };
    },
  };
}

export function installBudget(bus: CostRadarBudget, g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  g[BUDGET_BUS_KEY] = bus;
}

export function discoverBudget(g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): CostRadarBudget | undefined {
  const raw = g[BUDGET_BUS_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Partial<CostRadarBudget>;
  if (b.version !== 2 || typeof b.check !== "function" || typeof b.price !== "function") return undefined;
  return b as CostRadarBudget;
}

/** 仅创建该总线的实例可清理（非本实例调用为 no-op；防反序误删） */
export function uninstallBudget(instanceId: string, g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const cur = discoverBudget(g);
  if (cur && cur.instanceId === instanceId) delete g[BUDGET_BUS_KEY];
}
