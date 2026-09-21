import { describe, it, expect } from "vitest";
import { createBudget, installBudget, discoverBudget, uninstallBudget, BUDGET_BUS_KEY } from "./budget";
import type { Registry } from "./adapters/registry";

const reg = {
  lookup: (p: string, m: string) =>
    p === "vendor" && m === "m" ? ({ cost: (u: any, ts: number) => u.input * (ts === 0 ? 1 : 2) } as any) : null,
} as Registry;

const busOf = (limit: number | null, spend: number, cwd = "/w", owner = "s1", instance = "inst-1") =>
  createBudget({
    ownerSessionId: owner,
    instanceId: instance,
    cwd,
    getLimit: () => limit,
    getParentSpend: () => spend,
    getRegistry: () => reg,
  });

describe("budget bus", () => {
  it("check：cwd 匹配返回 limit/parentSpend；不匹配返回 null 保守值", () => {
    const b = busOf(5, 2);
    expect(b.check("/w")).toEqual({ limit: 5, parentSpend: 2 });
    expect(b.check("/other")).toEqual({ limit: null, parentSpend: 0 });
  });

  it("price：委托 pricing，带 tsMs；未收录返回 null", () => {
    const b = busOf(5, 0);
    expect(b.price("vendor", "m", { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }, 0)).toEqual({ yuan: 3, covered: true });
    expect(b.price("vendor", "m", { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }, 1)).toEqual({ yuan: 6, covered: true });
    expect(b.price("other", "x", { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }, 0)).toEqual({ yuan: null, covered: false });
  });

  it("只读性：多次 check/price 不改变 limit/spend 快照", () => {
    let limit = 5;
    let spend = 2;
    const b = createBudget({
      ownerSessionId: "s1", instanceId: "inst-1", cwd: "/w",
      getLimit: () => limit, getParentSpend: () => spend, getRegistry: () => reg,
    });
    b.check("/w"); b.price("vendor", "m", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, 0);
    expect(limit).toBe(5);
    expect(spend).toBe(2);
    expect(b.check("/w")).toEqual({ limit: 5, parentSpend: 2 });
  });

  it("install/discover/uninstall：本实例才可清理（实例标识）", () => {
    const g: Record<string, unknown> = {};
    const b = busOf(5, 0, "/w", "s1", "inst-1");
    installBudget(b, g);
    expect(discoverBudget(g)).toBe(b);
    expect(b.instanceId).toBe("inst-1");
    uninstallBudget("other-inst", g);     // 非本实例 → 不删
    expect(discoverBudget(g)).toBe(b);
    uninstallBudget("inst-1", g);         // 本实例 → 删
    expect(discoverBudget(g)).toBeUndefined();
  });

  it("实例标识：同 ownerSessionId 下旧实例 shutdown 不误删新 bus（防反序）", () => {
    const g: Record<string, unknown> = {};
    const oldBus = busOf(5, 0, "/w", "s1", "inst-old");
    const newBus = busOf(7, 0, "/w", "s1", "inst-new");
    installBudget(oldBus, g);
    installBudget(newBus, g);              // 同会话 reload 覆盖
    uninstallBudget("inst-old", g);        // 旧实例 shutdown 反序到达 → 不得删新 bus
    expect(discoverBudget(g)).toBe(newBus);
    uninstallBudget("inst-new", g);        // 新实例 shutdown → 删
    expect(discoverBudget(g)).toBeUndefined();
  });

  it("discover：version 不符 / 非对象 → undefined", () => {
    expect(discoverBudget({ [BUDGET_BUS_KEY]: { version: 1 } })).toBeUndefined();
    expect(discoverBudget({ [BUDGET_BUS_KEY]: 42 })).toBeUndefined();
    expect(discoverBudget({})).toBeUndefined();
  });
});
