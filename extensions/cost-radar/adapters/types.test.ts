import { describe, it, expect } from "vitest";
import { normalizeModelId, matchRow, mergeParamsDeep, validateParams, isInTimeWindow } from "./types";
import type { RowSpec } from "./types";

describe("normalizeModelId", () => {
  it("小写/点转横线/去日期后缀", () => {
    expect(normalizeModelId("Claude-Sonnet-4.5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalizeModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });
});
describe("mergeParamsDeep", () => {
  it("深合并单字段且数组整体替换、丢弃未知键", () => {
    const d = { input: 1, out: { a: 1, b: [1, 2] } };
    const o = { out: { b: [3], c: 9 }, junk: 0 };
    expect(mergeParamsDeep(d, o)).toEqual({ input: 1, out: { a: 1, b: [3] } });
  });
  it("null/undefined override 返回 defaults 克隆（不改原对象）", () => {
    const d = { a: 1, nested: { x: [1, 2], y: 2 } };
    expect(mergeParamsDeep(d, null)).toEqual(d);
    expect(mergeParamsDeep(d, null)).not.toBe(d);
    const m = mergeParamsDeep(d, undefined) as typeof d;
    m.nested.x.push(3);
    expect(d.nested.x).toEqual([1, 2]);
  });
});
describe("validateParams", () => {
  const schema = {
    input: { kind: "number", label: "input", min: 0 },
    valley: { kind: "group", label: "valley", schema: { offPeakFactor: { kind: "number", label: "f", min: 0, max: 1 } } },
  } as const;
  it("报非法与类型错误", () => {
    expect(validateParams(schema, { input: -1, valley: { offPeakFactor: 2 } })).toHaveLength(2);
    expect(validateParams(schema, { input: 3, valley: { offPeakFactor: 0.5 } })).toEqual([]);
    expect(validateParams(schema, { input: "abc", valley: { offPeakFactor: 0.5 } }).length).toBeGreaterThan(0);
  });
});
describe("isInTimeWindow", () => {
  const w = [{ start: "01:00", end: "04:00" }, { start: "06:00", end: "10:00" }];
  it("UTC 窗与边界 [start,end)", () => {
    const t = (h: number, wd = 3) => Date.UTC(2026, 0, 7 + wd, h, 0, 0); // 2026-01-07 是周三
    expect(isInTimeWindow(t(1, 2), w, "utc", false)).toBe(true);   // 周二 01:00 命中（weekdaysOnly=false）
    expect(isInTimeWindow(t(4, 2), w, "utc", false)).toBe(false);  // end 不含
    expect(isInTimeWindow(t(8, 2), w, "utc", false)).toBe(true);
  });
  it("weekdaysOnly：周六谷、周一峰", () => {
    const sat = Date.UTC(2026, 0, 10, 2, 0, 0), mon = Date.UTC(2026, 0, 12, 2, 0, 0);
    expect(isInTimeWindow(sat, w, "utc", true)).toBe(false);
    expect(isInTimeWindow(mon, w, "utc", true)).toBe(true);
  });
  it("跨午夜窗：end<=start 视为两段（22:00-02:00）", () => {
    const cross = [{ start: "22:00", end: "02:00" }];
    const thu = (h: number) => Date.UTC(2026, 0, 8, h, 0, 0);  // 周四
    expect(isInTimeWindow(thu(23), cross, "utc", false)).toBe(true);  // 首段 22:00→24:00
    expect(isInTimeWindow(thu(3), cross, "utc", false)).toBe(false);  // 空隙
    const fri = (h: number) => Date.UTC(2026, 0, 9, h, 0, 0);
    expect(isInTimeWindow(fri(1), cross, "utc", false)).toBe(true);   // 次段 00:00→02:00
    expect(isInTimeWindow(fri(2), cross, "utc", false)).toBe(false);  // end 不含
  });
});
describe("matchRow", () => {
  const rows: RowSpec[] = [
    { key: "deepseek/deepseek-v4-flash", provider: "deepseek", prefixes: ["deepseek-v4-flash"], family: "deepseek", currency: "cny", cacheable: true, schema: {}, defaults: {}, build: () => ({}) as never },
    { key: "deepseek/deepseek-v4-flash-vision-exp", provider: "deepseek", prefixes: ["deepseek-v4-flash-vision-exp"], family: "deepseek", currency: "cny", cacheable: true, schema: {}, defaults: {}, build: () => ({}) as never },
  ];
  it("前缀长优先：长前缀行优先于短前缀行", () => {
    expect(matchRow(rows, "deepseek", "deepseek-v4-flash-vision-exp")?.key)
      .toBe("deepseek/deepseek-v4-flash-vision-exp");
    expect(matchRow(rows, "deepseek", "deepseek-v4-flash")?.key)
      .toBe("deepseek/deepseek-v4-flash");
  });
  it("供应商不符/未知 id 不命中；modelId 先归一化", () => {
    expect(matchRow(rows, "anthropic", "deepseek-v4-flash")).toBeNull();
    expect(matchRow(rows, "deepseek", "deepseek-chat")).toBeNull();
    expect(matchRow(rows, "deepseek", "DeepSeek-V4-Flash-0731")?.key)
      .toBe("deepseek/deepseek-v4-flash");  // 日期后缀被剥掉后命中
  });
});
