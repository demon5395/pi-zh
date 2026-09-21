import { describe, it, expect } from "vitest";
import { ALL_ROWS, buildRegistry, listRows } from "./registry";

// 任务 1/2/3/4 行已由各 family 测试覆盖逐行 golden；本文件锁定 registry 层契约：
// usdRate 只作用于 USD 族、覆盖深合并生效、未收录不命中、listRows 行元数据导出。

describe("buildRegistry usdRate 注入", () => {
  it("USD 族受 usdRate 影响、CNY 族（含 DeepSeek）不受", () => {
    const t = Date.UTC(2026, 0, 12, 2, 0, 0); // 周一 02:00 UTC = DeepSeek 峰值
    const r7 = buildRegistry(7.2, {});
    const r1 = buildRegistry(1.0, {});
    const u = { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 };
    // USD 行（openai gpt-4o 未命中输入 $2.5/M）受 usdRate 影响
    expect(r1.lookup("openai", "gpt-4o")!.cost(u, t)).toBeCloseTo(2.5, 5);        // usdRate=1
    expect(r7.lookup("openai", "gpt-4o")!.cost(u, t)).toBeCloseTo(2.5 * 7.2, 5);  // usdRate=7.2
    // CNY 行（DeepSeek ¥2.0/M、moonshot ¥20/M 未命中输入）不受 usdRate 影响
    expect(r1.lookup("deepseek", "deepseek-v4-flash")!.cost(u, t)).toBeCloseTo(2.0, 5);
    expect(r7.lookup("deepseek", "deepseek-v4-flash")!.cost(u, t)).toBeCloseTo(2.0, 5);
    const m7 = r7.lookup("moonshotai-cn", "kimi-k3")!;
    const m1 = r1.lookup("moonshotai-cn", "kimi-k3")!;
    expect(m7.cost(u, t)).toBeCloseTo(20, 5);
    expect(m1.cost(u, t)).toBeCloseTo(20, 5);
  });
});

describe("buildRegistry 覆盖深合并", () => {
  it("覆盖深合并进参数并生效", () => {
    const t = Date.UTC(2026, 0, 12, 2, 0, 0);
    const r = buildRegistry(7.2, { "deepseek/deepseek-v4-flash": { inputMiss: 9.9 } });
    const f = r.lookup("deepseek", "deepseek-v4-flash")!;
    expect(f.params.inputMiss).toBe(9.9);
    // 未覆盖字段（offPeakFactor/窗口等）仍回默认
    expect(f.params.offPeakFactor).toBe(0.5);
    expect(f.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, t)).toBeCloseTo(9.9, 5); // CNY 行：¥/M 直读
  });
  it("覆盖不改写后续 build（每次新 registry 独立）", () => {
    const o = { "deepseek/deepseek-v4-flash": { inputMiss: 3 } };
    const r1 = buildRegistry(7.2, o);
    const r2 = buildRegistry(7.2, {});
    expect(r1.lookup("deepseek", "deepseek-v4-flash")!.params.inputMiss).toBe(3);
    expect(r2.lookup("deepseek", "deepseek-v4-flash")!.params.inputMiss).toBe(2.0);
  });
});

describe("buildRegistry 未收录判定", () => {
  it("未知模型/供应商不命中", () => {
    expect(buildRegistry(7.2, {}).lookup("openai", "gpt-4-nothing")).toBeNull(); // 无 gpt-4 宽前缀；gpt-5-* 现由 gpt-5 行兜底（见 openai.test）
    expect(buildRegistry(7.2, {}).lookup("deepseek", "deepseek-chat")).toBeNull(); // 旧模型已下架
    expect(buildRegistry(7.2, {}).lookup("unknown-vendor", "anything")).toBeNull();
  });
});

describe("listRows 行元数据", () => {
  it("导出全部内置行（含 key/provider/schema），key 全局唯一", () => {
    const rows = listRows();
    expect(rows).toEqual(ALL_ROWS);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of rows) {
      expect(row.key).toContain("/");
      expect(row.provider.length).toBeGreaterThan(0);
      expect(row.defaults._meta).toBeDefined(); // 每行默认参数带来源/核对日期
    }
  });
});
