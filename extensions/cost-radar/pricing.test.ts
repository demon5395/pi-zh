import { describe, it, expect } from "vitest";
import { adapterOf, makeCostFns } from "./pricing";
import type { Registry } from "./adapters/registry";

/** 桩 registry：仅 "vendor/m" 收录，cost = input 每 token ¥2 */
const stub: Registry = {
  lookup: (p: string, m: string) =>
    p === "vendor" && m === "m"
      ? { cost: (u: any) => u.input * 2 } as any
      : null,
};

describe("pricing", () => {
  it("adapterOf 解析 provider/model 键，非法键返回 null", () => {
    expect(adapterOf(stub, "vendor/m")).not.toBeNull();
    expect(adapterOf(stub, "vendor/")).toBeNull();
    expect(adapterOf(stub, "/m")).toBeNull();
    expect(adapterOf(stub, "nomodel")).toBeNull();
  });

  it("makeCostFns：coveredOf/costOf 与收录一致；未收录 costOf 返回 null", () => {
    const { coveredOf, costOf } = makeCostFns(stub);
    expect(coveredOf("vendor/m")).toBe(true);
    expect(coveredOf("other/x")).toBe(false);
    expect(costOf("vendor/m", { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }, 0)).toBe(6);
    expect(costOf("other/x", { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }, 0)).toBeNull();
  });
});
