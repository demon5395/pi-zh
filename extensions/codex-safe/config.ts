/**
 * 配置层：`codex-safe.json` 原子读写 + 消毒 + 损坏回退。
 *
 * 纯 IO，无 pi 依赖；`baseDir` 一律作为参数传入（可测性），默认目录由 index.ts 注入。
 * 写法与 cost-radar/config.ts 对齐：临时文件 + rename、mode 0600、危险键丢弃。
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ALLOWED_REGIONS, DEFAULT_SENTINELS } from "./hosts";

export const CONFIG_FILENAME = "codex-safe.json";

export interface CodexSafeConfig {
  enabled: boolean;
  proxyUrl: string;
  sentinels: string[];
  allowedRegions: string[];
  probeTimeoutMs: number;
  cacheTtlMs: number;
  noUiPolicy: "warn" | "block";
}

export const DEFAULT_CONFIG: CodexSafeConfig = {
  enabled: true,
  proxyUrl: "http://127.0.0.1:7890",
  sentinels: [...DEFAULT_SENTINELS],
  allowedRegions: [...DEFAULT_ALLOWED_REGIONS],
  probeTimeoutMs: 5000,
  cacheTtlMs: 10000,
  noUiPolicy: "warn",
};

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function boolField(v: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  warnings.push(`${field} 非布尔值，已用默认 ${fallback}`);
  return fallback;
}

function positiveNumber(v: unknown, fallback: number, field: string, warnings: string[]): number {
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  warnings.push(`${field} 需为 >0 的数字，已用默认 ${fallback}`);
  return fallback;
}

function stringField(v: unknown, fallback: string, field: string, warnings: string[]): string {
  if (v === undefined) return fallback;
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  warnings.push(`${field} 非空字符串，已用默认 ${fallback}`);
  return fallback;
}

function stringArrayField(
  v: unknown,
  fallback: readonly string[],
  field: string,
  warnings: string[],
): string[] {
  if (v === undefined) return [...fallback];
  if (!Array.isArray(v)) {
    warnings.push(`${field} 非数组，已用默认值`);
    return [...fallback];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  if (out.length === 0) {
    warnings.push(`${field} 为空或全部无效，已用默认值`);
    return [...fallback];
  }
  return out;
}

export function loadConfig(baseDir: string): { config: CodexSafeConfig; warnings: string[] } {
  const warnings: string[] = [];
  const file = path.join(baseDir, CONFIG_FILENAME);
  if (!fs.existsSync(file)) return { config: clone(DEFAULT_CONFIG), warnings };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      config: clone(DEFAULT_CONFIG),
      warnings: [`${CONFIG_FILENAME} 解析失败（非合法 JSON），已用默认配置`],
    };
  }
  if (!isPlainObject(raw)) {
    return { config: clone(DEFAULT_CONFIG), warnings: [`${CONFIG_FILENAME} 顶层非对象，已用默认配置`] };
  }

  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (DANGEROUS_KEYS.has(k)) {
      warnings.push(`${k} 为保留键，已丢弃`);
      continue;
    }
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }

  const noUi = o.noUiPolicy;
  let noUiPolicy: "warn" | "block" = DEFAULT_CONFIG.noUiPolicy;
  if (noUi !== undefined) {
    if (noUi === "warn" || noUi === "block") noUiPolicy = noUi;
    else warnings.push(`noUiPolicy 仅支持 "warn" | "block"，已用默认 ${DEFAULT_CONFIG.noUiPolicy}`);
  }

  const config: CodexSafeConfig = {
    enabled: boolField(o.enabled, DEFAULT_CONFIG.enabled, "enabled", warnings),
    proxyUrl: stringField(o.proxyUrl, DEFAULT_CONFIG.proxyUrl, "proxyUrl", warnings),
    sentinels: stringArrayField(o.sentinels, DEFAULT_CONFIG.sentinels, "sentinels", warnings),
    allowedRegions: stringArrayField(
      o.allowedRegions,
      DEFAULT_CONFIG.allowedRegions,
      "allowedRegions",
      warnings,
    ),
    probeTimeoutMs: positiveNumber(
      o.probeTimeoutMs,
      DEFAULT_CONFIG.probeTimeoutMs,
      "probeTimeoutMs",
      warnings,
    ),
    cacheTtlMs: positiveNumber(o.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs, "cacheTtlMs", warnings),
    noUiPolicy,
  };
  return { config, warnings };
}

export function saveConfig(baseDir: string, config: CodexSafeConfig): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const file = path.join(baseDir, CONFIG_FILENAME);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}
