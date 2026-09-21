import { describe, it, expect } from "vitest";
import { buildRegistry } from "./registry";

const R = buildRegistry(7.2, {});

describe("openai registry", () => {
  it("gpt-4o：三价 cost（命中价 1.25，cacheWrite=0 无写费）", () => {
    const m = R.lookup("openai", "gpt-4o")!;
    expect(m).not.toBeNull();
    const u = { input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 };
    expect(m.cost(u, 0)).toBeCloseTo((2.5 + 1.25 + 10) * 7.2, 5);
  });

  it("forecast：热=命中混合、冷=input、新=sys+out；gpt-4.1 族行独立", () => {
    const f = R.lookup("openai", "gpt-4.1")!.forecast({ q: 1e6, out: 2e5, sys: 1e5, hitRate: 0.9 }, 0);
    expect(f.hot).toBeCloseTo((0.9 * 0.5 + 0.1 * 2) * 7.2, 5);
    expect(f.cold).toBeCloseTo(2 * 7.2, 5);
    expect(f.fresh).toBeCloseTo((2 * 0.1 + 8 * 0.2) * 7.2, 5);
  });

  it("四行价独立（gpt-4o/4.1/4.1-mini/4.1-nano 防串价）", () => {
    const prices: [string, number, number, number][] = [
      // [modelId, input, output, cacheHit] USD/M
      ["gpt-4o", 2.5, 10, 1.25],
      ["gpt-4.1", 2, 8, 0.5],
      ["gpt-4.1-mini", 0.4, 1.6, 0.1],
      ["gpt-4.1-nano", 0.1, 0.4, 0.025],
    ];
    for (const [id, input, output, hit] of prices) {
      const m = R.lookup("openai", id)!;
      expect(m).not.toBeNull();
      expect(m.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(input * 7.2, 5);
      expect(m.cost({ input: 0, cacheRead: 0, cacheWrite: 0, output: 1e6 }, 0)).toBeCloseTo(output * 7.2, 5);
      expect(m.cost({ input: 0, cacheRead: 1e6, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(hit * 7.2, 5);
    }
  });

  it("防御：无写价档 → usage.cacheWrite>0 按 input 价计，不静默丢弃", () => {
    const m = R.lookup("openai", "gpt-4.1")!;
    expect(m.params.cacheWrite).toBeUndefined(); // 旧 4.x 行无写价字段
    expect(m.cost({ input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }, 0)).toBeCloseTo(2 * 7.2, 5);
  });
});

// 2026-09-13 官方页（platform.openai.com/docs/pricing）"Flagship models" Standard 短上下文档。
// 新旗舰有独立 cache writes 档（=1.25×input）——OpenAI 旧 4.x 行无写价，故 schema 可选、旧行防御不变。
const FLAGSHIP: [string, number, number, number, number][] = [
  // [modelId, input, cacheWrite, cacheHit, output] USD/M
  ["gpt-6-astra", 10, 12.5, 1, 50],
  ["gpt-5.6-sol", 4, 5, 0.4, 20],
  ["gpt-5.6-terra", 2, 2.5, 0.2, 12],
  ["gpt-5.6-luna", 0.2, 0.25, 0.02, 1.2],
];

describe("openai 新旗舰（缓存写入档）", () => {
  it("四行收录且 id 带点/日期后缀归一化命中", () => {
    expect(R.lookup("openai", "gpt-6-astra")).not.toBeNull();
    expect(R.lookup("openai", "gpt-5.6-sol-2026-11-01")).not.toBeNull(); // 归一化去日期 → gpt-5-6-sol
    expect(R.lookup("openai", "gpt-5.6-luna")).not.toBeNull();
    expect(R.lookup("openai", "gpt-5.6-terra")).not.toBeNull();
  });

  it("四价 cost（含官方缓存写入价，非防御按 input 计）", () => {
    for (const [id, input, write, hit, out] of FLAGSHIP) {
      const m = R.lookup("openai", id)!;
      expect(m).not.toBeNull();
      expect(m.params.cacheWrite).toBe(write); // 写价字段已声明并可覆盖
      expect(m.cost({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 }, 0))
        .toBeCloseTo((input + write + hit + out) * 7.2, 5);
    }
  });

  it("forecast：冷按写价、热按命中率混合读/写价", () => {
    const f = R.lookup("openai", "gpt-6-astra")!.forecast({ q: 1e6, out: 2e5, sys: 1e5, hitRate: 0.9 }, 0);
    expect(f.hot).toBeCloseTo((0.9 * 1 + 0.1 * 12.5) * 7.2, 5);
    expect(f.cold).toBeCloseTo(12.5 * 7.2, 5);
    expect(f.fresh).toBeCloseTo((10 * 0.1 + 50 * 0.2) * 7.2, 5);
  });
});

// 2026-09-13 补录中代 gpt-5.x（pi-ai 目录 cost 与官方 Standard 短上下文档一致）。
// 无写费档 → 三价 schema；长上下文（>272K）tier 不建模（usage 无上下文长度），取短档 golden。
const MIDGEN: [string, number, number, number][] = [
  // [modelId, input, cacheHit, output] USD/M（Standard 短上下文）
  ["gpt-5", 1.25, 0.125, 10],
  ["gpt-5-mini", 0.25, 0.025, 2],
  ["gpt-5-nano", 0.05, 0.005, 0.4],
  ["gpt-5-pro", 15, 0, 120],
  ["gpt-5.1", 1.25, 0.125, 10],
  ["gpt-5.2", 1.75, 0.175, 14],
  ["gpt-5.2-pro", 21, 0, 168],
  ["gpt-5.3-chat-latest", 1.75, 0.175, 14],
  ["gpt-5.3-codex", 1.75, 0.175, 14],
  ["gpt-5.3-codex-spark", 1.75, 0.175, 14],
  ["gpt-5.4", 2.5, 0.25, 15],
  ["gpt-5.4-mini", 0.75, 0.075, 4.5],
  ["gpt-5.4-nano", 0.2, 0.02, 1.25],
  ["gpt-5.4-pro", 30, 0, 180],
  ["gpt-5.5", 5, 0.5, 30],
  ["gpt-5.5-pro", 30, 0, 180],
];

describe("openai 中代 gpt-5.x", () => {
  it("全量收录且三价 cost 与目录一致（防串价）", () => {
    for (const [id, input, hit, out] of MIDGEN) {
      const m = R.lookup("openai", id)!;
      expect(m, id).not.toBeNull();
      expect(m.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0), `${id} input`).toBeCloseTo(input * 7.2, 5);
      expect(m.cost({ input: 0, cacheRead: 1e6, cacheWrite: 0, output: 0 }, 0), `${id} cacheRead`).toBeCloseTo(hit * 7.2, 5);
      expect(m.cost({ input: 0, cacheRead: 0, cacheWrite: 0, output: 1e6 }, 0), `${id} output`).toBeCloseTo(out * 7.2, 5);
    }
  });

  it("chat-latest / codex / dated 快照经最长前缀命中正确行（不被 gpt-5 短前缀吞并）", () => {
    expect(R.lookup("openai", "gpt-5-chat-latest")!.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(1.25 * 7.2, 5);
    expect(R.lookup("openai", "gpt-5.2-chat-latest")!.params.input).toBe(1.75);
    expect(R.lookup("openai", "gpt-5.3-chat-latest")!.params.input).toBe(1.75);
    expect(R.lookup("openai", "gpt-5.3-codex-spark")!.params.input).toBe(1.75);
    expect(R.lookup("openai", "gpt-5.4-mini-2026-01-01")!.params.input).toBe(0.75);
  });

  it("gpt-4o 前缀族防误配：gpt-4o-mini 与 dated 快照不被 gpt-4o 行吞并", () => {
    const mini = R.lookup("openai", "gpt-4o-mini")!;
    expect(mini.key).toBe("openai/gpt-4o-mini");
    expect(mini.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(0.15 * 7.2, 5);
    const dated = R.lookup("openai", "gpt-4o-2024-05-13")!;
    expect(dated.key).toBe("openai/gpt-4o-2024-05-13");
    expect(dated.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 0)).toBeCloseTo(5 * 7.2, 5);
    // 2024-08-06 / 2024-11-20 与基础 gpt-4o 同价，经 "gpt-4o" 前缀命中即为正确
    expect(R.lookup("openai", "gpt-4o-2024-08-06")!.params.input).toBe(2.5);
  });
});
