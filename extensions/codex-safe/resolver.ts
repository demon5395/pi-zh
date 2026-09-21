/**
 * 代理解析层：把配置里的代理地址解析为「当前运行环境实际可用的运行时地址」。
 *
 * 场景：Mac 宿主机跑代理、Linux Docker 容器跑 Pi/Codex 时，配置里的
 * `127.0.0.1` 指向容器自身而非宿主机。容器内需要把回环主机改写为
 * Docker Desktop 提供的 `host.docker.internal`，并保留协议、端口、认证、
 * 路径等其余语义。
 *
 * 约束：
 * - 纯解析，不读写任何配置文件（不把容器专用地址写回 `codex-safe.json`）。
 * - 宿主机与非回环地址原样返回。
 * - 环境判断与宿主解析均可注入，便于测试。
 * - 解析失败只报告，不回退直连。
 */
import dns from "node:dns";
import fs from "node:fs";

/** Docker 容器标识文件 */
export const DOCKER_ENV_FILE = "/.dockerenv";

/** Docker Desktop 暴露给容器的宿主机别名 */
export const HOST_DOCKER_INTERNAL = "host.docker.internal";

/** 视为回环、需要改写的代理主机（`URL.hostname` 对 IPv6 保留方括号） */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type ProxyResolution =
  | {
      ok: true;
      /** 原始配置/环境里的代理 URL，原样保留用于解释 */
      original: string;
      /** 当前运行环境实际应使用的代理 URL */
      runtime: string;
      /** 是否发生了回环 → host.docker.internal 改写 */
      rewritten: boolean;
      /** 非致命提示（如宿主别名无法解析） */
      warning?: string;
    }
  | {
      ok: false;
      original: string;
      error: string;
    };

export interface ResolveProxyDeps {
  /** 环境判断，默认检查 `/.dockerenv` */
  isContainer?: () => boolean;
  /**
   * 宿主名解析，默认 `dns.promises.lookup`。
   * 返回解析到的地址字符串，失败返回 `null`（不抛错）。
   */
  resolveHost?: (host: string) => Promise<string | null>;
}

/** DNS 查询函数签名（可注入，便于测试时避免真实 DNS） */
export type LookupFn = (host: string) => Promise<{ address: string }>;

const defaultLookup: LookupFn = (host) => dns.promises.lookup(host);

/** 默认容器判断：存在 `/.dockerenv` 即视为 Docker 容器 */
export function isContainer(): boolean {
  return fs.existsSync(DOCKER_ENV_FILE);
}

/**
 * 默认宿主解析：`dns.lookup`，失败返回 null，绝不抛错。
 * `lookup` 可注入，测试无需依赖真实 DNS。
 */
export async function defaultResolveHost(
  host: string,
  lookup: LookupFn = defaultLookup,
): Promise<string | null> {
  try {
    const r = await lookup(host);
    return r.address;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * 以解析后的 URL 结构重建运行时地址：只替换 hostname，保留协议、端口、
 * 认证信息与 pathname/query/hash。
 *
 * 之所以不再基于原始字符串替换，是因为 `new URL()` 接受诸如
 * `http:127.0.0.1:7890`（省略 `//`）的写法，而字符串替换找不到 `://`
 * 会原样返回，导致 `rewritten: true` 但 runtime 未真正改写。基于解析结果
 * 重建可保证「改写标志」与「实际主机变化」始终一致。
 */
function rebuildRuntimeUrl(parsed: URL, replacement: string): { runtime: string; hostChanged: boolean } {
  const runtimeUrl = new URL(parsed.href);
  runtimeUrl.hostname = replacement;
  return { runtime: runtimeUrl.href, hostChanged: runtimeUrl.hostname !== parsed.hostname };
}

/**
 * 解析代理 URL。
 *
 * - 非容器或非回环主机：`runtime === original`，`rewritten === false`。
 * - 容器内回环主机：主机替换为 `HOST_DOCKER_INTERNAL`，保留其余部分。
 * - URL 非法：返回 `ok: false` 的结构化错误。
 * - 改写后宿主别名无法解析：改写仍生效，但附带 warning 提示排查。
 */
export async function resolveProxyUrl(
  rawUrl: string,
  deps: ResolveProxyDeps = {},
): Promise<ProxyResolution> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, original: rawUrl, error: `非法代理 URL：${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, original: rawUrl, error: `代理 URL 仅支持 http/https：${rawUrl}` };
  }

  const inContainer = (deps.isContainer ?? isContainer)();
  if (!inContainer || !isLoopbackHost(parsed.hostname)) {
    return { ok: true, original: rawUrl, runtime: rawUrl, rewritten: false };
  }

  // 仅替换主机名：协议、端口、认证、pathname/query/hash 全部保留。
  const { runtime, hostChanged } = rebuildRuntimeUrl(parsed, HOST_DOCKER_INTERNAL);
  if (!hostChanged) {
    // 理论上不可达（进入本分支的 hostname 必为回环）；作为不变量兜底，
    // 避免再次出现「rewritten 与 runtime 不一致」。
    return { ok: true, original: rawUrl, runtime: rawUrl, rewritten: false };
  }

  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const address = await resolveHost(HOST_DOCKER_INTERNAL);
  if (address === null) {
    return {
      ok: true,
      original: rawUrl,
      runtime,
      rewritten: true,
      warning:
        `${HOST_DOCKER_INTERNAL} 无法解析：请确认 Docker Desktop 支持该别名，` +
        `或为 Compose 配置 extra_hosts: ["${HOST_DOCKER_INTERNAL}:host-gateway"]`,
    };
  }

  return { ok: true, original: rawUrl, runtime, rewritten: true };
}
