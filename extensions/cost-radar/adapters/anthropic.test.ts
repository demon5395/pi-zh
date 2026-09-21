import { describe, it, expect } from "vitest";
import { buildRegistry } from "./registry";

const R = buildRegistry(7.2, {});

describe("anthropic registry", () => {
  const s45 = R.lookup("anthropic", "claude-sonnet-4.5-20250929")!;  // normalize→claude-sonnet-4-5

  it("sonnet 4-x 前缀归一化命中 + 四价 cost", () => {
    expect(s45).not.toBeNull();
    const u = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };
    expect(s45.cost(u, 0)).toBeCloseTo((3 + 0.3 + 3.75 + 15) * 7.2, 5);
  });

  it("冷=整段写价、热=按命中率混合读价、新=sys 输入+out 输出", () => {
    const f = s45.forecast({ q: 1e6, out: 2e5, sys: 1e5, hitRate: 0.8 }, 0);
    expect(f.cold).toBeCloseTo(3.75 * 7.2, 5);
    expect(f.hot).toBeCloseTo((0.8 * 0.3 + 0.2 * 3.75) * 7.2, 5);
    expect(f.fresh).toBeCloseTo((3 * 0.1 + 15 * 0.2) * 7.2, 5);
  });

  it("opus-5 / opus-4-x / haiku-4-5 / sonnet-5 行参数独立（防同价行互换）", () => {
    const o5 = R.lookup("anthropic", "claude-opus-5-20260101")!;   // normalize→claude-opus-5
    expect(o5.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(5 * 7.2, 5);
    const o4x = R.lookup("anthropic", "claude-opus-4")!;           // 裸 id → opus-4-x 行
    expect(o4x.key).toBe("anthropic/claude-opus-4-x");
    // opus-5 与 opus-4-x 四价全同（5/6.25/0.5/25），单看 input 无法防行互换 → 补 cacheWrite/output 独立断言
    expect(o4x.cost({ input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }, 0)).toBeCloseTo(6.25 * 7.2, 5);
    expect(o4x.cost({ input: 0, cacheRead: 0, cacheWrite: 0, output: 1e6 }, 0)).toBeCloseTo(25 * 7.2, 5);
    const h = R.lookup("anthropic", "claude-haiku-4-5")!;
    expect(h.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(1 * 7.2, 5);
    // sonnet-5 与 sonnet-4-x 价格不同（2 vs 3 input），input+cacheWrite 联合断言防 4-x/5 行串价
    const s5 = R.lookup("anthropic", "claude-sonnet-5")!;
    expect(s5.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(2 * 7.2, 5);
    expect(s5.cost({ input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }, 0)).toBeCloseTo(2.5 * 7.2, 5);
  });
});

// 2026-09-13 官方页新增 Fable 5 / Fable 5.1（pi-ai 目录已收录 claude-fable-5 / -5-1）：
// 同 input/write/output，仅缓存命中价不同（5.1 = 0.25、5 = 1）——长前缀行优先匹配。
describe("anthropic Fable 5.x", () => {
  it("两行收录且长前缀优先（-5-1 不落 -5 行）", () => {
    const f51 = R.lookup("anthropic", "claude-fable-5-1")!;
    const f5 = R.lookup("anthropic", "claude-fable-5")!;
    expect(f51.key).toBe("anthropic/claude-fable-5-1");
    expect(f5.key).toBe("anthropic/claude-fable-5");
    expect(R.lookup("anthropic", "claude-fable-5-1-20260101")).toBe(f51); // 归一化去日期
  });

  it("四价 cost 与命中价区分", () => {
    const f51 = R.lookup("anthropic", "claude-fable-5-1")!;
    expect(f51.cost({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 }, 0))
      .toBeCloseTo((10 + 0.25 + 12.5 + 50) * 7.2, 5);
    const f5 = R.lookup("anthropic", "claude-fable-5")!;
    expect(f5.cost({ input: 0, cacheRead: 1e6, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(1 * 7.2, 5);
  });
});
