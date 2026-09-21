import { describe, it, expect } from "vitest";
import { buildRegistry } from "./registry";

/**
 * 阿里云百炼（Qwen）官方定价核对 —— 任务 4 执行期（2026-09-07）。
 * 来源：help.aliyun.com/zh/model-studio/billing-for-model-studio（模型调用价格表，
 * 官方按 ¥/每百万 token 公布，人民币行不乘 usdRate）+ context-cache 文档
 * （隐式缓存命中按输入标准单价 20% 计）。golden 数值 = 页面提取值。
 * 模型范围：qwen3.8-max / qwen3.8-flash —— 两行在页面上均为单档
 * （0<Token≤1M）、思考/非思考同价、全地域（北京/美国/新加坡/法兰克福/东京）同价，
 * 无阶梯歧义；qwen3.7-plus/flash 等阶梯+思考分档型号未收录。
 */
const R = buildRegistry(7.2, {});

describe("qwen registry", () => {
  it("收录 qwen3.8-max / qwen3.8-flash；阶梯分档的 qwen3.7-plus 未收录", () => {
    expect(R.lookup("qwen", "qwen3.8-max")).not.toBeNull();
    expect(R.lookup("qwen", "qwen3.8-flash")).not.toBeNull();
    expect(R.lookup("qwen", "qwen3.7-plus")).toBeNull();
  });
  it("id 带点形态经归一化命中（qwen3.8-max → qwen3-8-max）", () => {
    expect(R.lookup("qwen", "Qwen3.8-Max")).not.toBeNull();
  });
});

describe("qwen cost（¥/每百万 token，qwen3.8-max：输入 12 / 输出 36 / 隐式命中=12×20%）", () => {
  it("max：输入 + 命中折扣 + 输出", () => {
    const m = R.lookup("qwen", "qwen3.8-max")!;
    const u = { input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 };
    expect(m.cost(u, 0)).toBeCloseTo(12 + 12 * 0.2 + 36, 5);
  });
  it("¥ 行不受 usdRate 影响（currency:cny）", () => {
    const a = buildRegistry(7.2, {}).lookup("qwen", "qwen3.8-max")!;
    const b = buildRegistry(1.0, {}).lookup("qwen", "qwen3.8-max")!;
    expect(a.currency).toBe("cny");
    expect(a.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0))
      .toBeCloseTo(b.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0), 5);
  });
  it("防御：隐式缓存无单独写费 → cacheWrite>0 按输入价计", () => {
    const m = R.lookup("qwen", "qwen3.8-max")!;
    expect(m.cost({ input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }, 0)).toBeCloseTo(12, 5);
  });
  it("两行价独立：flash 输入 0.8 / 输出 2.7 / 命中 0.16", () => {
    const m = R.lookup("qwen", "qwen3.8-flash")!;
    expect(m.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(0.8, 5);
    expect(m.cost({ input: 0, cacheRead: 1e6, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(0.16, 5);
    expect(m.cost({ input: 0, cacheRead: 0, cacheWrite: 0, output: 1e6 }, 0)).toBeCloseTo(2.7, 5);
  });
});

describe("qwen forecast", () => {
  it("热=命中(20%)混合、冷=全额输入、新=sys 输入 + out 输出（max：12 / 2.4 / 36）", () => {
    const f = R.lookup("qwen", "qwen3.8-max")!.forecast({ q: 1e6, out: 2e5, sys: 1e5, hitRate: 0.8 }, 0);
    expect(f.hot).toBeCloseTo(0.8 * 2.4 + 0.2 * 12, 5);
    expect(f.cold).toBeCloseTo(12, 5);
    expect(f.fresh).toBeCloseTo(12 * 0.1 + 36 * 0.2, 5);
  });
});
