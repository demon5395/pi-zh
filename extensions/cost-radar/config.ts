/**
 * cost-radar 配置层（config.ts）
 *
 * 纯 IO + 校验，无 pi 依赖。层依赖：本文件只 import adapters/types（validateParams +
 * RowSpec 类型）；覆盖白名单（registry.listRows()）由调用方（index 面板/测试）传入——
 * `validateOverride` 的 `rows` 参数用于写入校验，`loadConfig` 的 `rows` 参数用于读取时的
 * 孤儿覆盖键告警；config 不 import core/index/registry。
 *
 * 职责：cost-radar.json 原子读写（临时文件 + rename）、结构消毒（损坏 → 默认 + warning）、
 * 覆盖按行 schema 校验、覆盖应用（先删后写整对象）、预设 CRUD。baseDir 一律作为参数
 * 传入（可测性），不读环境变量；默认目录（PI_CODING_AGENT_DIR / ~/.pi/agent）由
 * index.ts 注入。
 *
 * 原型键防护：配置文件是本地可控输入，但覆盖/预设 key 均来自外部 JSON，写入一律经
 * defineProperty（防 "__proto__" 等原型键污染，与 core 账本同思路）。
 */
import fs from "node:fs";
import path from "node:path";
import type { ParamValue, RowSpec } from "./adapters/types";
import { validateParams } from "./adapters/types";

/** 配置文件名（相对 baseDir） */
export const CONFIG_FILENAME = "cost-radar.json";

/** 覆盖表：RowSpec.key → 该行 schema 内字段的覆盖值（深合并，见 types.mergeParamsDeep） */
export type ConfigOverrides = Record<string, Record<string, ParamValue>>;

export interface CostRadarConfig {
  /** ¥/会话默认预算（出厂 ¥5）；null = 用户显式关闭（/cost budget clear 或面板清除） */
  defaultBudget: number | null;
  /** USD 计价族 → ¥ 换算汇率（>0；CNY 行不受影响） */
  usdRate: number;
  /** 模型行覆盖；恢复官方 = 清除该 key */
  priceOverrides: ConfigOverrides;
  /** 命名覆盖快照（值与 priceOverrides 同构），/cost 面板「保存为预设/载入/删除」 */
  userPresets: Record<string, ConfigOverrides>;
}

export const DEFAULT_CONFIG: CostRadarConfig = {
  defaultBudget: 5,
  usdRate: 7.2,
  priceOverrides: {},
  userPresets: {},
};

function clone<T>(v: T): T {
  return structuredClone(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 以自有数据属性写入（外部 key 防原型键污染） */
function setOwn(map: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

/** 原型/继承相关危险键：JSON 反序列化可产生自有 "__proto__" 等键，消毒时直接丢弃 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 结构消毒：map[string → 覆盖对象]；坏条目丢弃并记 warning（值字段不在此细验——按行 schema 校验在写入路径 validateOverride） */
function sanitizeFieldMap(
  v: unknown,
  field: string,
  warnings: string[],
): Record<string, Record<string, unknown>> {
  if (v === undefined) return {};
  if (!isPlainObject(v)) {
    warnings.push(`${field} 非对象，已忽略`);
    return {};
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, val] of Object.entries(v)) {
    if (DANGEROUS_KEYS.has(k)) {
      warnings.push(`${field}.${k} 为保留键，已丢弃`);
      continue;
    }
    if (isPlainObject(val)) setOwn(out, k, val);
    else warnings.push(`${field}.${k} 非覆盖对象，已忽略该条目`);
  }
  return out;
}

/** userPresets 消毒：预设名 → 覆盖表（两层 map） */
function sanitizePresets(v: unknown, warnings: string[]): Record<string, Record<string, Record<string, unknown>>> {
  if (v === undefined) return {};
  if (!isPlainObject(v)) {
    warnings.push("config.userPresets 非对象，已忽略");
    return {};
  }
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [name, preset] of Object.entries(v)) {
    if (DANGEROUS_KEYS.has(name)) {
      warnings.push(`config.userPresets.${name} 为保留键，已丢弃`);
      continue;
    }
    if (!isPlainObject(preset)) {
      warnings.push(`config.userPresets.${name} 非覆盖快照，已忽略`);
      continue;
    }
    const cleaned = sanitizeFieldMap(preset, `config.userPresets.${name}`, warnings);
    setOwn(out, name, cleaned);
  }
  return out;
}

/**
 * 孤儿覆盖键告警：rows 为内置清单白名单（调用方传 registry.listRows()）。
 * priceOverrides 中不在清单的键**永不会被应用**（buildRegistry 只遍历 ALL_ROWS），
 * userPresets 内层同类键则在「载入预设」时才被 validateOverride 过滤——两者此前均无任何提示，
 * 用户会误以为覆盖仍生效（典型来源：官方下线某模型行后，行被删而行内旧覆盖残留）。
 *
 * 仅**告警不删除**：数据保留在 config 中，若该行日后回归清单，覆盖可自动复活；提示可在
 * /cost 面板清理（面板覆盖列表由 listRows() 派生，孤儿键本就不可见）。按位置聚合为至多两条
 * warning，避免多孤儿键时报文爆炸。
 */
function warnOrphanOverrides(rows: RowSpec[], config: CostRadarConfig, warnings: string[]): void {
  const known = new Set(rows.map((r) => r.key));
  const orphans = (map: Record<string, unknown>) => Object.keys(map).filter((k) => !known.has(k));
  /** 至多列 3 个键，余量以数量归纳 */
  const fmtKeys = (keys: string[]) =>
    keys.length > 3 ? `${keys.slice(0, 3).join("、")} 等 ${keys.length} 个` : keys.join("、");

  const top = orphans(config.priceOverrides);
  if (top.length > 0) {
    warnings.push(
      `config.priceOverrides 含 ${top.length} 个不在内置清单的覆盖键（${fmtKeys(top)}），不会生效，可在 /cost 面板清理`,
    );
  }
  const badPresets: string[] = [];
  let presetKeys = 0;
  for (const [name, snapshot] of Object.entries(config.userPresets)) {
    const o = orphans(snapshot);
    if (o.length > 0) {
      presetKeys += o.length;
      badPresets.push(name);
    }
  }
  if (presetKeys > 0) {
    warnings.push(
      `config.userPresets 的 ${badPresets.length} 个预设含 ${presetKeys} 个不在内置清单的覆盖键（${fmtKeys(badPresets)}），载入时会被过滤`,
    );
  }
}

/**
 * 读 baseDir/cost-radar.json：
 * - 文件缺失 → 默认配置、无 warning；
 * - JSON.parse 失败 / 顶层非对象 → 默认配置 + warning；
 * - 合法对象 → 与默认结构合并（每字段类型消毒，坏字段回默认 + warning），返回新对象
 *   （调用方可安全 mutate 后 saveConfig）；
 * - rows 传入时额外做**孤儿覆盖键告警**（见 warnOrphanOverrides），
 *   不传则跳过（保持旧行为，测试/无 registry 场景不必造白名单）。
 */
export function loadConfig(baseDir: string, rows?: RowSpec[]): { config: CostRadarConfig; warnings: string[] } {
  const warnings: string[] = [];
  const file = path.join(baseDir, CONFIG_FILENAME);
  if (!fs.existsSync(file)) {
    return { config: clone(DEFAULT_CONFIG), warnings };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { config: clone(DEFAULT_CONFIG), warnings: [`${CONFIG_FILENAME} 解析失败（非合法 JSON），已用默认配置`] };
  }
  if (raw === null) {
    return { config: clone(DEFAULT_CONFIG), warnings: [`${CONFIG_FILENAME} 内容为空（null），已用默认配置`] };
  }
  if (!isPlainObject(raw)) {
    return { config: clone(DEFAULT_CONFIG), warnings: [`${CONFIG_FILENAME} 顶层非对象，已用默认配置`] };
  }
  const cfg = clone(DEFAULT_CONFIG);
  const o = raw as Record<string, unknown>;

  if (o.defaultBudget !== undefined) {
    const db = o.defaultBudget;
    if (db === null || (typeof db === "number" && Number.isFinite(db))) cfg.defaultBudget = db as number | null;
    else warnings.push("config.defaultBudget 非法（期望数字或 null），已用默认（¥5）");
  }
  if (o.usdRate !== undefined) {
    const usd = o.usdRate;
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) cfg.usdRate = usd;
    else warnings.push(`config.usdRate 非法（期望 >0 数字），已用默认 ${DEFAULT_CONFIG.usdRate}`);
  }
  cfg.priceOverrides = sanitizeFieldMap(o.priceOverrides, "config.priceOverrides", warnings) as ConfigOverrides;
  cfg.userPresets = sanitizePresets(o.userPresets, warnings) as Record<string, ConfigOverrides>;
  if (rows) warnOrphanOverrides(rows, cfg, warnings);

  return { config: cfg, warnings };
}

/**
 * 原子写：先写 cost-radar.json.tmp 再 fs.renameSync 覆盖目标（同目录 rename 原子，
 * 不会留下半成品）；baseDir 不存在则先创建。写入失败向上抛，由调用方（index）
 * notify 一次不崩溃。
 */
export function saveConfig(baseDir: string, config: CostRadarConfig): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const file = path.join(baseDir, CONFIG_FILENAME);
  const tmp = `${file}.tmp`;
  // mode 0o600：配置含预算/价格覆盖/预设等本地个人数据，不随 umask 放宽
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface OverrideVerdict {
  ok: boolean;
  errors: string[];
}

/**
 * 覆盖校验：key 必须命中 rows（调用方传 registry.listRows() 白名单）内的行，
 * 再按该行 schema validateParams（未知字段丢弃，均不算错误）。
 * 额外收紧：override 的**顶层键必须属于该行 schema**——defaults 中无 schema 的键
 * （如 deepseek 的 zone/weekdaysOnly/_meta）不可覆盖（_meta 为官方核对元数据、
 * 谷时语义按官方固定），防止绕过校验实际生效。
 * 返回 {ok, errors}，不抛异常。
 */
export function validateOverride(rows: RowSpec[], key: string, override: Record<string, ParamValue>): OverrideVerdict {
  const row = rows.find((r) => r.key === key);
  if (!row) {
    return { ok: false, errors: [`仅内置清单行可覆盖：未知覆盖键 "${key}"`] };
  }
  const errors = validateParams(row.schema, override);
  const schemaKeys = new Set(Object.keys(row.schema));
  for (const k of Object.keys(override)) {
    if (!schemaKeys.has(k)) {
      errors.push(`字段 "${k}" 不属于该行可覆盖参数（schema 无此键，含官方核对元数据/固定谷时语义）`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 应用覆盖到 config.priceOverrides：整对象替换（先删后写，单 key 旧字段清空）；
 * fields === null 表示清除该 key 覆盖（恢复官方）。原地修改，调用方随后 saveConfig。
 */
export function applyOverrides(config: CostRadarConfig, overrides: Record<string, Record<string, ParamValue> | null>): void {
  for (const [key, fields] of Object.entries(overrides)) {
    if (fields === null || fields === undefined) {
      delete config.priceOverrides[key];
    } else {
      setOwn(config.priceOverrides, key, clone(fields));
    }
  }
}

/** 已命名预设列表（userPresets 的 key，插入序） */
export function listPresets(config: CostRadarConfig): string[] {
  return Object.keys(config.userPresets);
}

/** 保存/覆盖命名预设（快照深拷贝，不落盘——调用方 saveConfig） */
export function savePreset(config: CostRadarConfig, name: string, snapshot: ConfigOverrides): void {
  setOwn(config.userPresets, name, clone(snapshot));
}

/** 删除命名预设；不存在返回 false（幂等，不抛异常） */
export function removePreset(config: CostRadarConfig, name: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(config.userPresets, name)) return false;
  delete config.userPresets[name];
  return true;
}
