/**
 * 探针层：两路取出口信息。
 *
 * - `proxied`：走 pi 的全局 `fetch`。pi 启动时用 undici 的 EnvHttpProxyAgent
 *   `setGlobalDispatcher`，并读 `settings.json` 的 `httpProxy` 注入 `HTTP_PROXY`/`HTTPS_PROXY`
 *   → 因此这一路会经过 `httpProxy` 与 Clash 规则，拿到的就是 OpenAI 实际看到的出口。
 * - `direct`：走 `node:https`。它不经过 undici，天然绕过 `HTTP_PROXY`/`HTTPS_PROXY`，
 *   拿到本机真实 ISP 出口 → 与 proxied 对比即可判断「规则有没有命中」。
 *
 * 两路探针都不携带任何凭证，打的是 Cloudflare 公开的 trace 端点。
 */
import https from "node:https";
import { TRACE_PATH } from "./hosts";

export interface TraceInfo {
  ip: string;
  loc: string;
  colo?: string;
}

export type ProbeOutcome =
  | { ok: true; info: TraceInfo }
  | { ok: false; reason: string };

export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<HttpResponseLike>;

export type HttpsGetLike = (
  url: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export function traceUrl(host: string): string {
  return `https://${host}${TRACE_PATH}`;
}

/** 解析 Cloudflare trace 的 `key=value` 行；缺 ip 或 loc 视为不可用 */
export function parseTrace(text: string): TraceInfo | null {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const ip = map.ip;
  const loc = map.loc;
  if (!ip || !loc) return null;
  return { ip, loc, colo: map.colo };
}

/** 默认直连实现：node:https，不经过 undici 全局 dispatcher */
export const defaultHttpsGet: HttpsGetLike = (url, opts) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: opts.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.from(c)));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          text: async () => Buffer.concat(chunks).toString("utf8"),
        }),
      );
      // body 传输中途连接断开时 res 会 emit 'error'；EventEmitter 无监听会抛
      // 未捕获异常（可能拖垮宿主进程）。Promise 的 settle 只生效一次，故此处
      // reject 不影响已 resolve 的 end 路径。
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${opts.timeoutMs}ms`)));
    req.on("error", reject);
    opts.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
  });

async function run(
  host: string,
  timeoutMs: number,
  get: (url: string, signal: AbortSignal) => Promise<HttpResponseLike>,
  external?: AbortSignal,
): Promise<ProbeOutcome> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  external?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await get(traceUrl(host), ctl.signal);
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
    const info = parseTrace(await res.text());
    return info ? { ok: true, info } : { ok: false, reason: "trace 格式异常" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

export interface ProbeDeps {
  fetchImpl?: FetchLike;
  httpsGetImpl?: HttpsGetLike;
  timeoutMs?: number;
}

export function probeProxied(
  host: string,
  deps: ProbeDeps = {},
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const fetchImpl: FetchLike =
    deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  return run(host, deps.timeoutMs ?? 5000, (url, s) => fetchImpl(url, { signal: s }), signal);
}

export function probeDirect(
  host: string,
  deps: ProbeDeps = {},
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const get = deps.httpsGetImpl ?? defaultHttpsGet;
  const timeoutMs = deps.timeoutMs ?? 5000;
  return run(host, timeoutMs, (url, s) => get(url, { timeoutMs, signal: s }), signal);
}

export async function probeDomain(
  host: string,
  deps: ProbeDeps = {},
  signal?: AbortSignal,
): Promise<{ host: string; proxied: ProbeOutcome; direct: ProbeOutcome }> {
  const [proxied, direct] = await Promise.all([
    probeProxied(host, deps, signal),
    probeDirect(host, deps, signal),
  ]);
  return { host, proxied, direct };
}
