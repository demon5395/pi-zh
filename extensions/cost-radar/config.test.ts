import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  applyOverrides,
  listPresets,
  loadConfig,
  removePreset,
  saveConfig,
  savePreset,
  validateOverride,
} from "./config";
import { buildRegistry, listRows } from "./adapters/registry";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig / saveConfig", () => {
  it("缺失文件 → 默认配置（无 warning）", () => {
    const r = loadConfig(dir);
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.warnings).toEqual([]);
  });
  it("roundtrip 原子写后值一致，无残留 tmp 半成品", () => {
    saveConfig(dir, { ...DEFAULT_CONFIG, usdRate: 7.1, defaultBudget: 3 });
    const c2 = loadConfig(dir);
    expect(c2.warnings).toEqual([]);
    expect(c2.config.usdRate).toBe(7.1);
    expect(c2.config.defaultBudget).toBe(3);
    expect(c2.config.priceOverrides).toEqual({});
    expect(fs.readdirSync(dir)).toEqual([CONFIG_FILENAME]);
  });
  it("saveConfig 写权限收紧：文件 mode 600（个人配置不外泄）", () => {
    saveConfig(dir, { ...DEFAULT_CONFIG, defaultBudget: 5 });
    const st = fs.statSync(path.join(dir, CONFIG_FILENAME));
    expect(st.mode & 0o777).toBe(0o600);
  });
  it("损坏 JSON → 默认配置 + warning", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), "{bad");
    const r = loadConfig(dir);
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("顶层非对象 JSON → 默认配置 + warning", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify([1, 2]));
    const r = loadConfig(dir);
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("结构合并：合法字段生效、坏字段回默认并警告", () => {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({ usdRate: 7.5, defaultBudget: "abc", priceOverrides: "junk" }),
    );
    const r = loadConfig(dir);
    expect(r.config.usdRate).toBe(7.5);
    expect(r.config.defaultBudget).toBe(5);      // 坏类型回默认（0.3.0 出厂默认 ¥5）
    expect(r.config.priceOverrides).toEqual({});    // 坏结构清空
    expect(r.warnings.some((w) => w.includes("defaultBudget"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("priceOverrides"))).toBe(true);
  });
  it("0.3.0 升级：文件存在但无 defaultBudget 字段 → 合入出厂默认 ¥5（升级不打扰）", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify({ usdRate: 7.1 }));
    const r = loadConfig(dir);
    expect(r.config.defaultBudget).toBe(5);
    expect(r.warnings).toEqual([]);
  });
  it("显式关闭保留：文件含 defaultBudget: null → 保持 null（不被出厂默认 ¥5 覆盖）", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify({ defaultBudget: null, usdRate: 7.1 }));
    const r = loadConfig(dir);
    expect(r.config.defaultBudget).toBeNull();
    expect(r.warnings).toEqual([]);
  });
});

describe("validateOverride（按 registry.listRows() 白名单与行 schema）", () => {
  it("非清单行 key 拒绝", () => {
    const v = validateOverride(listRows(), "foo/not-a-row", { inputMiss: 1 });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("仅内置清单行可覆盖");
  });
  it("字段越界/类型错拒绝；未知顶层键拒绝（收紧：须 ⊆ schema）", () => {
    expect(validateOverride(listRows(), "deepseek/deepseek-v4-flash", { inputMiss: -1 }).ok).toBe(false);
    expect(validateOverride(listRows(), "deepseek/deepseek-v4-flash", { inputMiss: "x" }).ok).toBe(false);
    // 收紧语义（见 validateOverride 注释）：schema 之外的键（含 junk / defaults 独有键）一律拒绝，
    // 防 zone/weekdaysOnly/_meta 等绕过校验实际生效
    const v = validateOverride(listRows(), "deepseek/deepseek-v4-flash", { junk: 1 });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("不属于该行可覆盖参数");
  });
  it("defaults 独有非 schema 键不可覆盖：zone/weekdaysOnly/_meta 拒绝（元数据与谷时语义锁定）", () => {
    for (const bad of ["zone", "weekdaysOnly", "_meta"]) {
      const v = validateOverride(listRows(), "deepseek/deepseek-v4-flash", { [bad]: bad === "_meta" ? { source: "x" } : bad === "zone" ? "utc" : false });
      expect(v.ok).toBe(false);
      expect(v.errors[0]).toContain("不属于该行可覆盖参数");
    }
    // 合法 schema 键（含嵌套 windowList 顶层键 peakWindows）不受影响
    expect(validateOverride(listRows(), "deepseek/deepseek-v4-flash", { inputMiss: 9.9, peakWindows: [{ start: "01:00", end: "04:00" }] }).ok).toBe(true);
  });
  it("部分字段（深合并）合法通过", () => {
    const v = validateOverride(listRows(), "deepseek/deepseek-v4-flash", { inputMiss: 9.9 });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    // 嵌套 group/窗口行也可按行 schema 校验
    expect(validateOverride(listRows(), "deepseek/deepseek-v4-flash", { offPeakFactor: 2 }).ok).toBe(false);
  });
});

describe("applyOverrides / 预设 CRUD", () => {
  it("applyOverrides：整对象替换（先删后写）+ null 清除", () => {
    const cfg = loadConfig(dir).config;
    applyOverrides(cfg, { "deepseek/deepseek-v4-flash": { inputMiss: 9.9 } });
    expect(cfg.priceOverrides["deepseek/deepseek-v4-flash"]).toEqual({ inputMiss: 9.9 });
    applyOverrides(cfg, { "deepseek/deepseek-v4-flash": { output: 2 } }); // 整对象替换：inputMiss 覆盖丢弃
    expect(cfg.priceOverrides["deepseek/deepseek-v4-flash"]).toEqual({ output: 2 });
    applyOverrides(cfg, { "deepseek/deepseek-v4-flash": null }); // 清除（恢复官方）
    expect(Object.keys(cfg.priceOverrides)).toEqual([]);
  });
  it("预设 CRUD：保存/载入/删除幂等", () => {
    const cfg = loadConfig(dir).config;
    expect(listPresets(cfg)).toEqual([]);
    savePreset(cfg, "flash-custom", { "deepseek/deepseek-v4-flash": { inputMiss: 5 } });
    expect(listPresets(cfg)).toEqual(["flash-custom"]);
    // 载入预设 = 将快照整体应用进 priceOverrides（不删除预设本身）
    applyOverrides(cfg, cfg.userPresets["flash-custom"]);
    expect(cfg.priceOverrides["deepseek/deepseek-v4-flash"]).toEqual({ inputMiss: 5 });
    expect(removePreset(cfg, "missing")).toBe(false);
    expect(removePreset(cfg, "flash-custom")).toBe(true);
    expect(removePreset(cfg, "flash-custom")).toBe(false); // 再删幂等
    expect(listPresets(cfg)).toEqual([]);
  });
  it("预设快照不被外部改动污染（保存即拷贝）", () => {
    const cfg = loadConfig(dir).config;
    const snap = { "deepseek/deepseek-v4-flash": { inputMiss: 5 } };
    savePreset(cfg, "s1", snap);
    snap["deepseek/deepseek-v4-flash"] = { inputMiss: 99 }; // 外部改原对象
    expect(cfg.userPresets["s1"]["deepseek/deepseek-v4-flash"]).toEqual({ inputMiss: 5 });
  });
  it("原型键防护：__proto__/constructor 作预设名或覆盖键不污染对象", () => {
    const cfg = loadConfig(dir).config;
    savePreset(cfg, "__proto__", { "deepseek/deepseek-v4-flash": { inputMiss: 5 } });
    expect(Object.prototype.hasOwnProperty.call(cfg.userPresets, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(cfg.userPresets)).not.toBe(null);   // 常规对象：写入走 defineProperty，未破坏原型
    expect(({} as Record<string, unknown>).inputMiss).toBeUndefined();
    applyOverrides(cfg, { constructor: { inputMiss: 1 }, "deepseek/deepseek-v4-flash": null });
    expect(Object.keys(cfg.priceOverrides)).toEqual(["constructor"]);
    expect((cfg.priceOverrides as Record<string, unknown>).constructor).not.toBe(Object);
    // 载入含 __proto__ 顶层键的恶意 JSON（原始字符串模拟 JSON.parse 自有键语义）→ 消毒丢弃且不污染
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), '{"priceOverrides":{"__proto__":{"inputMiss":1},"constructor":{"inputMiss":2}}}');
    const r = loadConfig(dir);
    expect(r.config.priceOverrides).toEqual({});
    expect(r.warnings.some((w) => w.includes("__proto__"))).toBe(true);
    expect(({} as Record<string, unknown>).inputMiss).toBeUndefined();
  });
});

describe("孤儿覆盖键告警（loadConfig 传 rows 白名单）", () => {
  const write = (o: unknown) => fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(o));
  it("不传 rows → 不校验（保持旧行为，无 warning）", () => {
    write({ priceOverrides: { "deepseek/deepseek-v4-flash-vision-exp": { inputMiss: 5 } } });
    const r = loadConfig(dir);
    expect(r.warnings).toEqual([]);
  });
  it("已下线行的旧覆盖 → 告警一次（聚合），多条归纳为「等 N 个」，且数据保留不删除", () => {
    write({
      priceOverrides: {
        "deepseek/deepseek-v4-flash-vision-exp": { inputMiss: 5 },
        "deepseek/gone-a": { inputMiss: 1 },
        "deepseek/gone-b": { inputMiss: 2 },
        "deepseek/gone-c": { inputMiss: 3 },
        "deepseek/deepseek-v4-flash": { inputMiss: 9.9 },
      },
    });
    const r = loadConfig(dir, listRows());
    const w = r.warnings.filter((x) => x.includes("priceOverrides"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("含 4 个不在内置清单的覆盖键"); // 合法键 deepseek-v4-flash 不计入
    expect(w[0]).toContain("deepseek/deepseek-v4-flash-vision-exp");
    expect(w[0]).toContain("等 4 个");
    expect(w[0]).toContain("不会生效");
    // 不删除：孤儿键仍在 config 中（日后行回归则覆盖自动复活）
    expect(Object.keys(r.config.priceOverrides)).toHaveLength(5);
  });
  it("全部键均在白名单 → 无孤儿告警", () => {
    write({ priceOverrides: { "deepseek/deepseek-v4-flash": { inputMiss: 9.9 } } });
    expect(loadConfig(dir, listRows()).warnings).toEqual([]);
  });
  it("预设内层孤儿键 → 按预设名独立聚合告警，>3 个预设归纳为「等 N 个」", () => {
    write({
      userPresets: {
        p1: { "deepseek/gone-a": { inputMiss: 1 } },
        p2: { "deepseek/gone-b": { inputMiss: 2 }, "deepseek/gone-c": { inputMiss: 3 } },
        p3: { "deepseek/deepseek-v4-pro": { inputMiss: 8 } },
        p4: { "deepseek/gone-d": { inputMiss: 4 } },
        p5: { "deepseek/gone-e": { inputMiss: 5 } },
      },
    });
    const r = loadConfig(dir, listRows());
    const w = r.warnings.filter((x) => x.includes("userPresets"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("的 4 个预设含 5 个不在内置清单的覆盖键"); // p3 全合法不计入
    expect(w[0]).toContain("载入时会被过滤");
    // 预设快照保留原样（仅在「载入预设」时被 validateOverride 过滤）
    expect(Object.keys(r.config.userPresets["p2"])).toHaveLength(2);
  });
});

describe("端到端：validate → apply → 原子持久化 → registry 生效", () => {
  it("覆盖经整条链路后 cost 按新价（¥9.9/M 直读，usdRate 不参与）", () => {
    const v = validateOverride(listRows(), "deepseek/deepseek-v4-flash", { inputMiss: 9.9 });
    expect(v.ok).toBe(true);
    const cfg = loadConfig(dir).config;
    applyOverrides(cfg, { "deepseek/deepseek-v4-flash": { inputMiss: 9.9 } });
    saveConfig(dir, cfg);
    const reloaded = loadConfig(dir);
    expect(reloaded.warnings).toEqual([]);
    const R = buildRegistry(reloaded.config.usdRate, reloaded.config.priceOverrides);
    const f = R.lookup("deepseek", "deepseek-v4-flash")!;
    expect(f.params.inputMiss).toBe(9.9);
    const t = Date.UTC(2026, 0, 12, 2, 0, 0); // 周一 02:00 UTC 峰值
    expect(f.cost({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, t)).toBeCloseTo(9.9, 5);
  });
});
