import { describe, it, expect } from "vitest";
import { assembleWizOverride, BUDGET_ACTIONS, collectWizEntries, formatSubagentLine, parseNumberField } from "./panel";
import type { ParamSchema, ParamValue } from "./adapters/types";

/**
 * panel.ts 纯辅助单测（extensions/cost-radar/panel.test.ts）
 *
 * 覆盖拆分自 index.ts 的面板纯函数：collectWizEntries / assembleWizOverride /
 * parseNumberField——number/windowList/group 三种 schema 的合法展平与还原、非法值
 * （schema 外键/缺失 cur/越界）的防御语义。本文件位于扩展深层，不参与 pi 扩展发现
 * （发现规则：扩展目录只认 index.ts 入口）。
 */

/** 向导条目结构型（等价 panel.WizEntry，不导出内部类型即复用其签名） */
type WizEntry = Parameters<typeof collectWizEntries>[3][number];

/** 模拟价目行三态 schema（number/group/windowList 各一，group 递归一层） */
const SCHEMA: ParamSchema = {
  price: { kind: "number", label: "单价", unit: "USD", min: 0, max: 100 },
  valley: { kind: "group", label: "谷时", schema: { factor: { kind: "number", label: "系数", min: 0, max: 1 } } },
  windows: { kind: "windowList", label: "谷时段" },
};

const WINDOWS: { start: string; end: string }[] = [
  { start: "01:00", end: "02:00" },
  { start: "13:00", end: "14:00" },
];

/** 当前生效值（含 defaults 中不可覆盖的 zone/_meta——不得进入录入计划） */
const CUR: Record<string, ParamValue> = {
  price: 3.5,
  valley: { factor: 0.5 },
  windows: WINDOWS,
  zone: "utc",
  _meta: { source: "官方核对" },
};

describe("collectWizEntries", () => {
  it("number/windowList/group 展平为点分路径条目（group 子字段带前缀，携带 unit/min/max 与当前值）", () => {
    const out: WizEntry[] = [];
    collectWizEntries(SCHEMA, CUR, "", out);
    expect(out.map((e) => e.path)).toEqual(["price", "valley.factor", "windows"]); // zone/_meta 不进计划
    const price = out[0];
    expect(price).toMatchObject({ kind: "number", label: "单价", unit: "USD", min: 0, max: 100, cur: 3.5 });
    expect(out[1]).toMatchObject({ kind: "number", path: "valley.factor", label: "系数", min: 0, max: 1, cur: 0.5 });
    expect(out[2]).toMatchObject({ kind: "windowList", path: "windows", label: "谷时段" });
    expect(out[2].cur).toEqual(WINDOWS);
  });

  it("cur 缺失/形变时回落：number→0、windowList→[]（不抛错，向导仍可推进）", () => {
    const empty: WizEntry[] = [];
    collectWizEntries(SCHEMA, {}, "", empty);
    expect(empty.find((e) => e.path === "price")?.cur).toBe(0);
    expect(empty.find((e) => e.path === "windows")?.cur).toEqual([]);
    expect(empty.find((e) => e.path === "valley.factor")?.cur).toBe(0); // group 递归照常：子字段 cur 回落 0
    const badWin: WizEntry[] = [];
    collectWizEntries(SCHEMA, { windows: "不是数组" }, "", badWin);
    expect(badWin.find((e) => e.path === "windows")?.cur).toEqual([]);
  });
});

describe("assembleWizOverride", () => {
  it("点分路径还原为嵌套覆盖（仅 schema 键：flat 外键 zone/_meta、缺失键一律忽略）", () => {
    const flat = new Map<string, ParamValue>([
      ["price", 8.8],
      ["valley.factor", 0.25],
      ["windows", WINDOWS],
      ["zone", "utc"], // 非 schema 键，即使存在也不还原
      ["price.junk", 1],
    ]);
    expect(assembleWizOverride(SCHEMA, flat)).toEqual({ price: 8.8, valley: { factor: 0.25 }, windows: WINDOWS });
  });

  it("collect→assemble 往返一致；group 子字段全缺则整组裁剪", () => {
    const out: WizEntry[] = [];
    collectWizEntries(SCHEMA, CUR, "", out);
    const flat = new Map(out.map((e) => [e.path, e.cur]));
    // 往返后：zone/_meta 被剥离，其余与 CUR 一致（windows 为深拷贝语义相等）
    expect(assembleWizOverride(SCHEMA, flat)).toEqual({ price: 3.5, valley: { factor: 0.5 }, windows: WINDOWS });
    // group 子字段路径缺失 → 该键不产出；空 flat → 空对象
    expect(assembleWizOverride(SCHEMA, new Map([["price", 1]]))).toEqual({ price: 1 });
    expect(assembleWizOverride(SCHEMA, new Map())).toEqual({});
  });
});

describe("parseNumberField", () => {
  it("留空=保留当前（keep）；非法/越界返回错误文案，不抛错", () => {
    expect(parseNumberField("", 5, {})).toEqual({ ok: true, keep: true, value: 5 });
    expect(parseNumberField("  12.5 ", 0, {})).toEqual({ ok: true, keep: false, value: 12.5 });
    const bad = parseNumberField("abc", 5, {});
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.error).toContain("不是有效数字");
    const lo = parseNumberField("-1", 0.5, { min: 0.01 });
    if (lo.ok === false) expect(lo.error).toContain("不能小于 0.01");
    const hi = parseNumberField("9", 5, { max: 8 });
    if (hi.ok === false) expect(hi.error).toContain("不能大于 8");
  });
});

describe("预算页动作（BUDGET_ACTIONS）", () => {
  it("0.3.0：含设置/清除默认与设置/清除本会话预算四动作，无「提额」残留", () => {
    const values = BUDGET_ACTIONS.map((a) => a.value);
    expect(values).toEqual(["set", "setSession", "clearDefault", "clearSession"]);
    const labels = BUDGET_ACTIONS.map((a) => a.label).join(" ");
    expect(labels).toContain("设置本会话预算");
    expect(labels).toContain("清除本会话预算");
    expect(labels).not.toContain("提额");
  });
});

describe("子代理汇总行", () => {
  // fmtYuan：0→"0"；0<y<1→3 位；否则 2 位（core.ts:208）
  it("有子代理时显示次数与金额；未收录追加提示；无缺 provider 时不追加", () => {
    expect(formatSubagentLine({ count: 2, yuan: 0.42, unpriced: 1 }, 0)).toBe("子代理（2 次）¥0.420 （1 条未收录不计）");
    expect(formatSubagentLine({ count: 1, yuan: 0, unpriced: 0 }, 0)).toBe("子代理（1 次）¥0");
    expect(formatSubagentLine({ count: 0, yuan: 0, unpriced: 0 }, 0)).toBeNull();
  });

  it("缺 provider 追加提示：与汇总行拼接、单独成行（E7）、无则不追加", () => {
    expect(formatSubagentLine({ count: 2, yuan: 0.42, unpriced: 0 }, 3)).toBe(
      "子代理（2 次）¥0.420 ｜ 3 条缺少 provider 未计入（需升级 pi-subagent）",
    );
    // E7：只升 cost-radar（旧版 pi-subagent）→ count===0 仍必须渲染
    expect(formatSubagentLine({ count: 0, yuan: 0, unpriced: 0 }, 2)).toBe(
      "2 条缺少 provider 未计入（需升级 pi-subagent）",
    );
  });

  it("跨 cwd 追加提示：与汇总行/缺 provider 拼接，无则不追加", () => {
    expect(formatSubagentLine({ count: 2, yuan: 0.42, unpriced: 0 }, 0, 1)).toBe(
      "子代理（2 次）¥0.420 ｜ 1 次子代理未纳入共享闸门",
    );
    expect(formatSubagentLine({ count: 0, yuan: 0, unpriced: 0 }, 0, 2)).toBe(
      "2 次子代理未纳入共享闸门",
    );
    expect(formatSubagentLine({ count: 2, yuan: 0.42, unpriced: 0 }, 3, 1)).toBe(
      "子代理（2 次）¥0.420 ｜ 3 条缺少 provider 未计入（需升级 pi-subagent） ｜ 1 次子代理未纳入共享闸门",
    );
    expect(formatSubagentLine({ count: 2, yuan: 0.42, unpriced: 0 }, 0, 0)).toBe(
      "子代理（2 次）¥0.420",
    );
  });
});
