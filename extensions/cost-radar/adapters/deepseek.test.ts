import { describe, it, expect } from "vitest";
import { DEEPSEEK_ROWS } from "./deepseek";
import { buildRegistry } from "./registry";   // 本任务先建 registry 骨架：仅汇总 DEEPSEEK_ROWS
const R = buildRegistry(7.2, {});
const flash = R.lookup("deepseek", "deepseek-v4-flash")!;

describe("deepseek registry", () => {
  it("收录两模型（flash/pro）、pro 未收录于 flash 行", () => {
    expect(R.lookup("deepseek", "deepseek-v4-flash")).not.toBeNull();
    expect(R.lookup("deepseek", "deepseek-v4-pro")).not.toBeNull();
    expect(R.lookup("deepseek", "deepseek-chat")).toBeNull();  // 旧模型已下架 → 未收录
  });

  it("已下线的 flash-vision-exp 不再独立成行，前缀回落到 flash 行（同价）", () => {
    expect(DEEPSEEK_ROWS.some((r) => r.key.includes("vision-exp"))).toBe(false);
    expect(R.lookup("deepseek", "deepseek-v4-flash-vision-exp")!.key).toBe("deepseek/deepseek-v4-flash");
    expect(R.lookup("deepseek", "deepseek-flash-vision-exp")!.key).toBe("deepseek/deepseek-v4-flash");
  });

  it("官方页现役 id deepseek-flash 别名命中 flash 行（与 deepseek-v4-flash 同行同价）", () => {
    const alias = R.lookup("deepseek", "deepseek-flash");
    expect(alias).not.toBeNull();
    expect(alias!.key).toBe("deepseek/deepseek-v4-flash");
    const t = Date.UTC(2026, 0, 12, 2, 0, 0); // 峰值
    expect(alias!.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, t)).toBeCloseTo(2.0, 6);
  });
});
// flash 峰值价：miss 2.0 / hit 0.04 / out 8.0（CNY/M，2026-09-13 官方页下调）；谷=×0.5；usdRate 不参与
const P = { miss: 2.0, hit: 0.04, out: 8.0 };
const PK = Date.UTC(2026, 0, 12, 2, 0, 0);   // 周一 02:00 UTC = 峰值
const OFF = Date.UTC(2026, 0, 10, 2, 0, 0);  // 周六 02:00 = 谷

describe("deepseek cost", () => {
  // 本用例意图为「1M 未命中输入：峰值全额、谷半价」，向量取 output:0 以隔离输入档。
  // （官方 output 峰值 ¥8.0/谷 ¥4.0 由下方 forecast 与 pro 用例覆盖。）
  it("峰值全额、谷半价", () => {
    const u = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    expect(flash.cost(u, PK)).toBeCloseTo(P.miss, 6);           // ¥2.0 每 M
    expect(flash.cost(u, OFF)).toBeCloseTo(P.miss * 0.5, 6);
  });
  it("含命中价（峰/谷）", () => {
    const u = { input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 };
    expect(flash.cost(u, PK)).toBeCloseTo(P.hit, 6);
    expect(flash.cost(u, OFF)).toBeCloseTo(P.hit * 0.5, 6);
  });
  it("pro 价格行独立（miss ¥9.0/M）", () => {
    const pro = R.lookup("deepseek", "deepseek-v4-pro")!;
    expect(pro.cost({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }, PK))
      .toBeCloseTo(9.0, 6);
  });
});
describe("deepseek forecast", () => {
  it("hot 按命中率混合 / cold=全额 miss / fresh=sys miss + out 输出（峰值价）", () => {
    const f = flash.forecast({ q: 1_000_000, out: 200_000, sys: 100_000, hitRate: 0.8 }, PK);
    expect(f.hot).toBeCloseTo(1_000_000 / 1e6 * (0.8 * P.hit + 0.2 * P.miss), 6);
    expect(f.cold).toBeCloseTo(P.miss, 6);
    expect(f.fresh).toBeCloseTo(P.miss * 0.1 + P.out * 0.2, 6);
  });
});
