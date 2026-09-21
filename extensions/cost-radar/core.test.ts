import { describe, it, expect } from "vitest";
import {
  aggregateLedger, cacheState, writeShare, hitRateOf,
  deriveNextTurn, budgetState, fmtYuan, fmtTokens, fmtClock,
  suggestNewSession, assembleStatusLine, parseYuanAmount,
} from "./core";

const costOf = (k: string, u: any) => (k === "deepseek/deepseek-v4-flash" ? u.input * 3.168 : null);
const rows = [
  { modelKey: "deepseek/deepseek-v4-flash", usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }, tsMs: 1 },
  { modelKey: "deepseek/deepseek-v4-flash", usage: { input: 0, output: 0, cacheRead: 2000, cacheWrite: 0 }, tsMs: 2 },
  { modelKey: null, usage: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0 }, tsMs: 3 },   // 工具无归属
  { modelKey: "some/vendor-unknown", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, tsMs: 4 },
];

describe("aggregateLedger", () => {
  it("账本：归属金额/无归属 token/未收录标注/总 token", () => {
    const r = aggregateLedger(rows, costOf, (k) => k === "deepseek/deepseek-v4-flash");
    expect(r.spendYuan).toBeCloseTo(1000 * 3.168, 9);
    expect(r.unallocatedTokens.input).toBe(300);
    expect(r.rawTokens.input).toBe(1310);
    expect(r.allCovered).toBe(false);
    expect(r.perModel["deepseek/deepseek-v4-flash"].tokens.cacheRead).toBe(2000);
    expect(r.perModel["some/vendor-unknown"]).toBeUndefined();   // 未收录不建条目
  });
  it("账本边界：空 rows / 全无归属 / 已收录但 costOf null 按 0 计", () => {
    const empty = aggregateLedger([], costOf, () => true);
    expect(empty.spendYuan).toBe(0);
    expect(empty.allCovered).toBe(true);
    expect(Object.keys(empty.perModel)).toHaveLength(0);
    const allUnalloc = aggregateLedger(rows.filter((r) => r.modelKey === null), costOf, () => true);
    expect(allUnalloc.spendYuan).toBe(0);
    expect(allUnalloc.unallocatedTokens.input).toBe(300);
    expect(Object.keys(allUnalloc.perModel)).toHaveLength(0);
    // costOf 对已覆盖键返回 null → 金额按 0，不崩溃
    const nullCost = aggregateLedger(rows.slice(0, 1), () => null, () => true);
    expect(nullCost.spendYuan).toBe(0);
    expect(nullCost.perModel["deepseek/deepseek-v4-flash"].yuan).toBe(0);
  });
  it("账本：原型键污染防护（__proto__ 等 modelKey 不崩溃）", () => {
    const evil = [{ modelKey: "__proto__", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, tsMs: 1 }];
    const r = aggregateLedger(evil, () => 1, () => true);
    expect(r.perModel["__proto__"].yuan).toBe(1);
    expect(Object.getPrototypeOf(r.perModel)).toBeNull();   // Object.create(null)：无原型继承键
  });
});

describe("cacheState", () => {
  it("缓存状态机：unknown/rebuilding(写>50%)/warm(命中率≥95%)/expired(idle≥TTL)", () => {
    const ttl = 300_000;
    expect(cacheState({ lastInput: 0, lastCacheRead: 0, lastCacheWrite: 0, lastActivityMs: 1, nowMs: 2, ttlMs: ttl }).phase).toBe("unknown");
    expect(cacheState({ lastInput: 100, lastCacheRead: 0, lastCacheWrite: 300, lastActivityMs: 1, nowMs: 2, ttlMs: ttl }).phase).toBe("rebuilding");
    expect(writeShare({ input: 100, cacheRead: 0, cacheWrite: 300, output: 0 })).toBeCloseTo(0.75, 9);
    expect(hitRateOf({ input: 100, cacheRead: 900, cacheWrite: 0, output: 0 })).toBeCloseTo(0.9, 9);
    const warmIn = { lastInput: 100, lastCacheRead: 900, lastCacheWrite: 0, lastActivityMs: 0, nowMs: ttl - 1, ttlMs: ttl };
    expect(cacheState(warmIn).phase).toBe("warm");
    expect(cacheState(warmIn).secondsLeft).toBe(1);
    expect(cacheState({ ...warmIn, nowMs: ttl }).phase).toBe("expired");
    expect(cacheState({ ...warmIn, nowMs: ttl }).secondsLeft).toBeNull();
  });
});

// ─── 任务 6：第 2 批（输入量推导 / 预算 / 格式 / 状态行拼装 / 新会话徽标）───

describe("deriveNextTurn", () => {
  it("输入量推导：Q=最近 prompt 合计、O=均值(不足取有值/空=0)、sys=chars/4", () => {
    expect(deriveNextTurn({ lastPromptTokens: 5000, outs: [100, 300], systemChars: 400, lastUserChars: 200 }))
      .toEqual({ q: 5000, out: 200, sys: 150 });
    expect(deriveNextTurn({ lastPromptTokens: null, outs: [], systemChars: 0, lastUserChars: 0 })).toEqual({ q: 0, out: 0, sys: 0 });
  });
});

describe("budgetState", () => {
  it("预算：未设关闭 / 本会话预算优先 / 色阶", () => {
    expect(budgetState({ defaultBudget: null, sessionBudget: null, spendYuan: 1 }).enabled).toBe(false);
    expect(budgetState({ defaultBudget: 10, sessionBudget: 5, spendYuan: 4 }).limitYuan).toBe(5);
    const b = budgetState({ defaultBudget: 10, sessionBudget: null, spendYuan: 9 });
    expect(b.pct).toBe(90); expect(b.tier).toBe("warn");
    expect(budgetState({ defaultBudget: 10, sessionBudget: null, spendYuan: 11 }).tier).toBe("over");
    // 0 是合法额度（本会话预算=0 → enabled、pct=100、over），不是「未设」——锁定 ?? 而非 || 语义
    const zero = budgetState({ defaultBudget: 10, sessionBudget: 0, spendYuan: 0 });
    expect(zero.enabled).toBe(true);
    expect(zero.limitYuan).toBe(0);
    expect(zero.pct).toBe(100);
    expect(zero.tier).toBe("over");
  });
  it("出厂默认 ¥5：defaultBudget=5 → enabled、limitYuan=5（闸门默认开）", () => {
    const d = budgetState({ defaultBudget: 5, sessionBudget: null, spendYuan: 1 });
    expect(d.enabled).toBe(true);
    expect(d.limitYuan).toBe(5);
    expect(d.tier).toBe("ok");
  });
});

describe("格式化/新会话徽标", () => {
  it("格式：¥ 精度/时钟/徽标阈值", () => {
    expect(fmtYuan(1)).toBe("1.00"); expect(fmtYuan(0.087)).toBe("0.087"); expect(fmtYuan(0)).toBe("0");
    expect(fmtClock(1)).toBe("0:01"); expect(fmtClock(272)).toBe("4:32");
    expect(suggestNewSession(86, 0.2, 0.5)).toEqual({ show: true, savePerRoundYuan: 0.3 });        // 上下文>85%
    expect(suggestNewSession(50, 0.2, 0.02)).toEqual({ show: false, savePerRoundYuan: -0.18 });   // 冷<0.05 不提示
    expect(suggestNewSession(50, 0.3, 1.0)).toEqual({ show: true, savePerRoundYuan: 0.7 });       // 冷>新×2 且冷>0.05
  });
  it("fmtTokens：k/M 缩写、整数化、0/负/小数健壮", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(523)).toBe("523");
    expect(fmtTokens(1_500)).toBe("1.5k");
    expect(fmtTokens(2_300_000)).toBe("2.3M");
    expect(fmtTokens(12.6)).toBe("13");
    expect(fmtTokens(-8)).toBe("-8");
  });
});

// ─── 任务 10 优化：¥ 金额严格解析（/cost budget CLI / 闸门本会话预算 / 面板预算共用语义）───

describe("parseYuanAmount", () => {
  it("合法：普通十进制（整数/小数）与 >0 边界值", () => {
    expect(parseYuanAmount("10")).toBe(10);
    expect(parseYuanAmount("0.5")).toBe(0.5);
    expect(parseYuanAmount("10.25")).toBe(10.25);
    expect(parseYuanAmount("0.01")).toBe(0.01);
    expect(parseYuanAmount("0.001")).toBe(0.001);
  });
  it("拒绝：0 与负数（下限 >0）", () => {
    expect(parseYuanAmount("0")).toBeNull();
    expect(parseYuanAmount("0.00")).toBeNull();
    expect(parseYuanAmount("-5")).toBeNull();
    expect(parseYuanAmount("-0.5")).toBeNull();
  });
  it("拒绝：NaN/Infinity/hex/二进制/八进制/指数科学计数（Number() 会误收）", () => {
    expect(parseYuanAmount("NaN")).toBeNull();
    expect(parseYuanAmount("Infinity")).toBeNull();
    expect(parseYuanAmount("0x10")).toBeNull(); // Number() 误读 16
    expect(parseYuanAmount("0b101")).toBeNull();
    expect(parseYuanAmount("0o17")).toBeNull();
    expect(parseYuanAmount("1e5")).toBeNull(); // Number() 误读 100000
    expect(parseYuanAmount("2.5e-3")).toBeNull();
  });
  it("拒绝：空串/空白（含首尾与内部）/非纯十进制串（符号剥离是调用方职责）", () => {
    expect(parseYuanAmount("")).toBeNull();
    expect(parseYuanAmount(" 10")).toBeNull();
    expect(parseYuanAmount("10 ")).toBeNull();
    expect(parseYuanAmount("1 0")).toBeNull();
    expect(parseYuanAmount("10.5元")).toBeNull();
    expect(parseYuanAmount("¥10")).toBeNull();
    expect(parseYuanAmount("10,000")).toBeNull();
    expect(parseYuanAmount(".5")).toBeNull();
    expect(parseYuanAmount("10.")).toBeNull();
    expect(parseYuanAmount("+10")).toBeNull();
  });
});

describe("assembleStatusLine", () => {
  it("状态行拼装：尾部丢段保 ≤45", () => {
    const parts = ["⛽12.34", "续0.03/冷0.38/新0.02", "⚡4:32", "预算84%", "💡新会话省0.36/轮"];
    expect(assembleStatusLine(parts).length).toBeLessThanOrEqual(45);
    expect(assembleStatusLine(["⛽0.00"]).length).toBeLessThanOrEqual(45);
  });
  it("状态行拼装：超长从尾部丢段、保头部 spend（尾部丢段语义锁定）", () => {
    const spend = "⛽12.34";
    const s = assembleStatusLine([spend, "甲段", "乙段", "丙段", "丁段"], 8);
    // cap=8："⛽12.34 甲段"(9)超长 → 丢甲段 → "⛽12.34"(6) 合规，保头部 spend
    expect(s).toBe("⛽12.34");
    expect(s.startsWith(spend)).toBe(true);
    // cap 足够时全保留、顺序不变；空输入返回空串、不改入参
    expect(assembleStatusLine(["a", "b", "c"], 50)).toBe("a b c");
    expect(assembleStatusLine([], 45)).toBe("");
    const input = ["a", "b"];
    assembleStatusLine(input, 1);
    expect(input).toEqual(["a", "b"]);
  });
});

describe("aggregateLedger：子代理来源统计", () => {
  const costOf2 = (k: string, u: any) => (k === "p/m" ? u.input * 1 : null);
  const covered = (k: string) => k === "p/m";

  it("子代理可计/未收录分别计数与金额", () => {
    const rows: any[] = [
      { modelKey: "p/m", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, tsMs: 1, subagent: true },
      { modelKey: "q/n", usage: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 }, tsMs: 2, subagent: true },
    ];
    const r = aggregateLedger(rows, costOf2, covered);
    expect(r.subagent.count).toBe(2);
    expect(r.subagent.yuan).toBeCloseTo(10, 9);
    expect(r.subagent.unpriced).toBe(1);
  });

  it("非子代理行不进入子代理统计（恒等降级）", () => {
    const rows: any[] = [
      { modelKey: "p/m", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, tsMs: 1 },
    ];
    const r = aggregateLedger(rows, costOf2, covered);
    expect(r.subagent.count).toBe(0);
    expect(r.subagent.yuan).toBe(0);
    expect(r.subagent.unpriced).toBe(0);
  });
});
