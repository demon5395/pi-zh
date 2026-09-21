/**
 * pi `settings.json` 的 `httpProxy` 读写（本扩展唯一的危险副作用）。
 *
 * pi 启动时会执行 `applyHttpProxySettings(settings.httpProxy)`：
 *   process.env.HTTP_PROXY ??= proxy; process.env.HTTPS_PROXY ??= proxy;
 * 随后 `configureHttpDispatcher()` 构造 EnvHttpProxyAgent（构造时读 process.env）。
 * 推论（必须体现在提示文案里）：
 *   1. 运行期改 settings.json **不影响当前进程**，必须重启 pi；
 *   2. 若 shell 已导出 HTTP_PROXY/HTTPS_PROXY，settings.json 的值会被 `??=` 绕过。
 *
 * 写入策略：保留其它字段、写前备份、临时文件 + 原子 rename。
 */
import fs from "node:fs";
import path from "node:path";

export interface ProxyEditResult {
  changed: boolean;
  hadField: boolean;
  backupPath?: string;
}

export function isValidProxyUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.hostname.length > 0;
}

function readRaw(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(text); // 损坏 → 抛错，调用方负责提示，绝不覆盖
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("settings.json 顶层不是对象，拒绝改写");
  }
  return parsed as Record<string, unknown>;
}

function writeAtomic(file: string, obj: Record<string, unknown>, backup: boolean): string | undefined {
  let backupPath: string | undefined;
  if (backup && fs.existsSync(file)) {
    backupPath = `${file}.codex-safe.bak`;
    fs.copyFileSync(file, backupPath);
  }
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
  return backupPath;
}

export function readHttpProxy(file: string): string | undefined {
  try {
    const o = readRaw(file);
    return typeof o.httpProxy === "string" && o.httpProxy.trim() !== "" ? o.httpProxy : undefined;
  } catch {
    return undefined;
  }
}

export function setHttpProxy(file: string, url: string): ProxyEditResult {
  if (!isValidProxyUrl(url)) {
    throw new Error(`代理地址需为 http:// 或 https:// 且含主机名，收到：${url}`);
  }
  const trimmed = url.trim();
  const o = readRaw(file);
  const hadField = typeof o.httpProxy === "string" && o.httpProxy.trim() !== "";
  if (hadField && o.httpProxy === trimmed) return { changed: false, hadField };
  const next = { ...o, httpProxy: trimmed };
  const backupPath = writeAtomic(file, next, true);
  return { changed: true, hadField, backupPath };
}

export function clearHttpProxy(file: string): ProxyEditResult {
  const o = readRaw(file);
  const hadField = "httpProxy" in o;
  if (!hadField) return { changed: false, hadField: false };
  const next = { ...o };
  delete next.httpProxy;
  const backupPath = writeAtomic(file, next, true);
  return { changed: true, hadField: true, backupPath };
}

/** 当前进程实际生效的代理值：pi 的 `??=` 语义下，shell 导出的变量优先 */
export function resolveEffectiveProxy(env: NodeJS.ProcessEnv): {
  value?: string;
  source: "HTTP_PROXY" | "HTTPS_PROXY" | "none";
} {
  const http = env.HTTP_PROXY ?? env.http_proxy;
  if (http) return { value: http, source: "HTTP_PROXY" };
  const https = env.HTTPS_PROXY ?? env.https_proxy;
  if (https) return { value: https, source: "HTTPS_PROXY" };
  return { source: "none" };
}
