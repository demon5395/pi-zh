import { describe, it, expect } from "vitest";
import { buildRegistry } from "./registry";

/**
 * Moonshot（Kimi）官方定价核对 —— 2026-09-13 复核。
 * 来源：定价页已迁至 platform.kimi.com/docs/pricing/chat（Mintlify 静态 markdown）；
 * 旧 platform.moonshot.cn/docs/pricing/chat-{k3,k27-code,k26} 链接失效。
 * 官方按 ¥/1M token 公布（人民币行，不乘 usdRate）。golden 数值 = 页面提取值（四项不变）。
 */
const R = buildRegistry(7.2, {});

describe("moonshot registry", () => {
  it("收录 k3 / k2.7-code / k2.7-code-highspeed / k2.6 四行；旧 k2 系列页面已下架未收录", () => {
    expect(R.lookup("moonshotai-cn", "kimi-k3")).not.toBeNull();
    expect(R.lookup("moonshotai-cn", "kimi-k2.7-code")).not.toBeNull();
    expect(R.lookup("moonshotai-cn", "kimi-k2.7-code-highspeed")).not.toBeNull();
    expect(R.lookup("moonshotai-cn", "kimi-k2.6")).not.toBeNull();
    expect(R.lookup("moonshotai-cn", "kimi-k2-0711-preview")).toBeNull();
  });

  it("id 带点形态与大小写经归一化命中（kimi-k2.7-code → kimi-k2-7-code）", () => {
    expect(R.lookup("moonshotai-cn", "Kimi-K2.7-Code")).not.toBeNull();
  });

  it("四行 _meta.source 均指向新定价页 platform.kimi.com", () => {
    for (const id of ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"]) {
      const meta = R.lookup("moonshotai-cn", id)!.params._meta as { source: string };
      expect(meta.source).toBe("https://platform.kimi.com/docs/pricing/chat");
    }
  });
});

describe("moonshot cost（¥/1M，kimi-k3：命中 2 / 未命中 20 / 输出 100）", () => {
  it("k3 三价 cost 与缓存命中折扣", () => {
    const m = R.lookup("moonshotai-cn", "kimi-k3")!;
    const u = { input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 };
    expect(m.cost(u, 0)).toBeCloseTo(20 + 2 + 100, 5);
  });
  it("¥ 行不受 usdRate 影响（currency:cny，build 不乘 usdRate）", () => {
    const a = buildRegistry(7.2, {}).lookup("moonshotai-cn", "kimi-k3")!;
    const b = buildRegistry(1.0, {}).lookup("moonshotai-cn", "kimi-k3")!;
    expect(a.currency).toBe("cny");
    expect(a.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0))
      .toBeCloseTo(b.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0), 5);
  });
  it("防御：无写费档 → cacheWrite>0 按未命中输入价计", () => {
    const m = R.lookup("moonshotai-cn", "kimi-k3")!;
    expect(m.cost({ input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }, 0)).toBeCloseTo(20, 5);
  });
  it("四行价独立（防串价）：k2.7-code 6.5/1.3/27、highspeed 13/2.6/54、k2.6 6.5/1.1/27", () => {
    const rows: [string, number, number, number][] = [
      // [id, inputMiss, inputHit, output] ¥/M（页面提取）
      ["kimi-k2.7-code", 6.5, 1.3, 27],
      ["kimi-k2.7-code-highspeed", 13, 2.6, 54],
      ["kimi-k2.6", 6.5, 1.1, 27],
    ];
    for (const [id, miss, hit, out] of rows) {
      const m = R.lookup("moonshotai-cn", id)!;
      expect(m).not.toBeNull();
      expect(m.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(miss, 5);
      expect(m.cost({ input: 0, cacheRead: 1e6, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(hit, 5);
      expect(m.cost({ input: 0, cacheRead: 0, cacheWrite: 0, output: 1e6 }, 0)).toBeCloseTo(out, 5);
    }
  });
});

describe("moonshot forecast", () => {
  it("热=命中混合、冷=全额未命中、新=sys 未命中 + out 输出（k3：miss 20 / hit 2 / out 100）", () => {
    const f = R.lookup("moonshotai-cn", "kimi-k3")!.forecast({ q: 1e6, out: 2e5, sys: 1e5, hitRate: 0.8 }, 0);
    expect(f.hot).toBeCloseTo(0.8 * 2 + 0.2 * 20, 5);
    expect(f.cold).toBeCloseTo(20, 5);
    expect(f.fresh).toBeCloseTo(20 * 0.1 + 100 * 0.2, 5);
  });
});
