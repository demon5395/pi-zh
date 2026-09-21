/**
 * 计价器契约层（adapters/types.ts）
 *
 * 纯类型 + 通用工具，无任何内部依赖（层依赖规则：本文件不被 core/index 反向依赖，
 * family 适配器与 registry 可 import 本文件，本文件不 import 其他模块）。
 * UsageLike/ForecastInput 等为 pi-ai 相关类型的本地结构型 —— pi-zh 运行时不可解析
 * pi-ai，禁止 import（运行时不可解析该模块）。
 */

export type Family = "deepseek" | "anthropic" | "openai" | "glm" | "moonshot" | "qwen";

/** pi-ai Usage 的本地结构型（pi-zh 运行时不可解析 pi-ai，禁止 import） */
export interface UsageLike {
  input: number;      // 未命中输入（新写入）
  output: number;
  cacheRead: number;  // 缓存命中
  cacheWrite: number; // 缓存写入（无写费族恒为 0）
}

export interface ForecastInput { q: number; out: number; sys: number; hitRate: number }
export interface Forecast { hot: number; cold: number; fresh: number }  // 单位 ¥

/** 参数 schema：供 config 校验与 /cost 单价向导驱动 */
export type ParamField =
  | { kind: "number"; label: string; unit?: string; min?: number; max?: number }
  | { kind: "group"; label: string; schema: ParamSchema }
  | { kind: "windowList"; label: string; weekdaysLabel?: string };
export type ParamSchema = { [field: string]: ParamField };
export type ParamValue = number | string | boolean | ParamValue[] | { [k: string]: ParamValue };

export interface ModelAdapter {
  key: string;              // RowSpec.key（覆盖寻址键）
  family: Family;
  currency: "usd" | "cny";
  cacheable: boolean;       // 是否有缓存命中/写入档（false 时状态行不显示缓存段）
  params: Record<string, ParamValue>;   // 已深合并的有效参数（含 _meta）
  /** 已发生费用，返回 ¥；null = 不可计 */
  cost(u: UsageLike, ts: number): number | null;
  /** 三档预估，返回 ¥（峰/谷由 ts 决定） */
  forecast(i: ForecastInput, ts: number): Forecast;
  hasValley: boolean;
  /** 可选：当前是否谷时（折扣） */
  inValley?(ts: number): boolean;
}

export interface RowSpec {
  key: string;            // "provider/规范模型名"，覆盖与账本寻址键
  provider: string;       // pi message 的 provider 字段
  prefixes: string[];     // 匹配 normalized modelId 的前缀（长前缀优先）
  family: Family;
  currency: "usd" | "cny";
  cacheable: boolean;
  schema: ParamSchema;
  defaults: Record<string, ParamValue>;   // 官方默认（含 _meta:{source,verifiedAt}）
  build(params: Record<string, ParamValue>, usdRate: number): ModelAdapter;
}

/** modelId 归一化：小写、"."→"-"、去尾部 "-YYYYMMDD" */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
}

/** 单行匹配强度：精确 id 集合相等 → Infinity；否则最长匹配前缀长度；无匹配 → -1 */
function prefixMatchLen(prefixes: string[], id: string): number {
  let best = -1;
  for (const p of prefixes) {
    const np = normalizeModelId(p);
    if (np === id) return Number.POSITIVE_INFINITY;
    if (id.startsWith(np) && np.length > best) best = np.length;
  }
  return best;
}

/** 前缀长优先匹配：先 provider 相等，再取前缀最长（精确归一化 id 恒胜）的行；无命中返回 null */
export function matchRow(rows: RowSpec[], provider: string, modelId: string): RowSpec | null {
  const id = normalizeModelId(modelId);
  let hit: RowSpec | null = null;
  let best = -1;
  for (const row of rows) {
    if (row.provider !== provider) continue;
    const l = prefixMatchLen(row.prefixes, id);
    if (l > best) {
      best = l;
      hit = row;
    }
  }
  return hit;
}

function clone<T>(v: T): T {
  return v !== undefined ? structuredClone(v) : v;
}

function isPlainObject(v: unknown): v is Record<string, ParamValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** schema 感知深合并（数组整体替换、标量覆盖、未知字段丢弃）；null/undefined override 返回 defaults 克隆 */
export function mergeParamsDeep(
  defaults: Record<string, ParamValue>,
  override: Record<string, ParamValue> | null | undefined,
): Record<string, ParamValue> {
  if (override == null) return clone(defaults);
  const out: Record<string, ParamValue> = {};
  for (const key of Object.keys(defaults)) {
    const dv = defaults[key];
    const ov = override[key];
    if (ov === undefined || ov === null) {
      out[key] = clone(dv);          // 覆盖缺失/显式 null → 保留默认
    } else if (isPlainObject(dv) && isPlainObject(ov)) {
      out[key] = mergeParamsDeep(dv, ov);
    } else {
      out[key] = clone(ov);          // 数组整体替换 / 标量覆盖
    }
  }
  return out;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** 解析 "HH:MM" 为当日分钟数；非法格式返回 null */
function parseHHMM(s: unknown): number | null {
  if (!isNonEmptyString(s)) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** schema 校验：非法字段/类型/越界返回错误列表（不抛异常）；未知键按深合并语义静默丢弃 */
export function validateParams(schema: ParamSchema, value: unknown, path = "params"): string[] {
  if (!isPlainObject(value)) return [`${path}: 期望对象`];
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    const field = schema[key];
    const v = value[key];
    const p = `${path}.${key}`;
    if (v === undefined) continue;   // 缺省字段 = 沿用默认，不报错
    switch (field.kind) {
      case "number": {
        if (typeof v !== "number" || Number.isNaN(v)) {
          errors.push(`${p}: 期望数字`);
        } else {
          if (field.min !== undefined && v < field.min) errors.push(`${p}: 不能小于 ${field.min}`);
          if (field.max !== undefined && v > field.max) errors.push(`${p}: 不能大于 ${field.max}`);
        }
        break;
      }
      case "group": {
        if (!isPlainObject(v)) errors.push(`${p}: 期望对象`);
        else errors.push(...validateParams(field.schema, v, p));
        break;
      }
      case "windowList": {
        if (!Array.isArray(v) || v.length === 0) {
          errors.push(`${p}: 期望非空时段列表`);
          break;
        }
        v.forEach((w, i) => {
          const wp = `${p}[${i}]`;
          if (!isPlainObject(w)) {
            errors.push(`${wp}: 期望 {start,end}`);
            return;
          }
          const s = parseHHMM(w.start), e = parseHHMM(w.end);
          if (s === null) errors.push(`${wp}.start: 期望 HH:MM`);
          if (e === null) errors.push(`${wp}.end: 期望 HH:MM`);
        });
        break;
      }
    }
  }
  return errors;
}

/**
 * 时段判定：windows=[{start:"HH:MM",end:"HH:MM"}]，zone 目前仅 "utc"，
 * weekdaysOnly 时仅 UTC Mon-Fri（getUTCDay()，周六 6/周日 0 跳过）；
 * 端点 [start,end)；end<=start 视为跨午夜两段（start→24:00 与 00:00→end）。
 */
export function isInTimeWindow(
  ts: number,
  windows: { start: string; end: string }[],
  zone: "utc",
  weekdaysOnly: boolean,
): boolean {
  if (zone !== "utc") return false;
  const d = new Date(ts);
  if (weekdaysOnly) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) return false;
  }
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const w of windows) {
    const s = parseHHMM(w.start), e = parseHHMM(w.end);
    if (s === null || e === null) continue;
    if (s <= e ? m >= s && m < e : m >= s || m < e) return true;
  }
  return false;
}
