/**
 * 守卫层：把「探针 → 判定」组合成带 TTL 缓存的决策单元。
 *
 * 缓存的 key 包含 hosts 与 allowedRegions：配置变了必须重探，不能吃旧结论。
 * 本层不做任何 UI、不 import pi（可测性）；调度（定时器、abort）在 index.ts。
 */
import { aggregateVerdict, judgeDomain } from "./judge";
import type { DomainVerdict, Verdict } from "./judge";
import type { ProbeOutcome } from "./probe";

export interface GuardCheckInput {
  hosts: readonly string[];
  allowedRegions: readonly string[];
  ttlMs: number;
  force?: boolean;
}

export interface GuardResult {
  verdict: Verdict;
  domains: DomainVerdict[];
  checkedAt: number;
  fromCache: boolean;
}

export interface GuardDeps {
  probeDomain: (
    host: string,
  ) => Promise<{ host: string; proxied: ProbeOutcome; direct: ProbeOutcome }>;
  now: () => number;
}

export interface Guard {
  check(input: GuardCheckInput): Promise<GuardResult>;
  /** 强制下次检查重探（模型切换、配置变更、手动刷新时调用） */
  invalidate(): void;
  /** 最近一次结果（可能为空），供状态行读取而不触发探针 */
  peek(): GuardResult | undefined;
}

/**
 * 并行探测多个哨兵域名并逐域名判定。
 *
 * - **并行**：全部探针在同一个 tick 内发起，总耗时 ≈ 最慢的单域名，而非各域名之和；
 *   默认 3 哨兵 × 5s 超时时，串行最坏 15s，并行最坏 5s。
 * - **失败隔离**：单个域名探针抛错只把它判为 `UNKNOWN`，不影响其余域名；
 *   返回顺序与 `hosts` 一致（`Promise.all` 保序）。
 */
export async function probeHosts(
  hosts: readonly string[],
  probeDomain: GuardDeps["probeDomain"],
  allowedRegions: readonly string[],
): Promise<DomainVerdict[]> {
  return Promise.all(
    hosts.map(async (host): Promise<DomainVerdict> => {
      try {
        const { proxied, direct } = await probeDomain(host);
        return judgeDomain({ host, proxied, direct, allowedRegions });
      } catch (e) {
        return {
          host,
          verdict: "UNKNOWN",
          reason: `探针异常：${e instanceof Error ? e.message : String(e)}`,
          notes: [],
        };
      }
    }),
  );
}

export function createGuard(deps: GuardDeps): Guard {
  let last: GuardResult | undefined;
  let lastKey = "";

  const keyOf = (input: GuardCheckInput) =>
    `${[...input.hosts].sort().join(",")}|${[...input.allowedRegions].sort().join(",")}`;

  return {
    peek: () => last,

    invalidate() {
      last = undefined;
      lastKey = "";
    },

    async check(input: GuardCheckInput): Promise<GuardResult> {
      // 缓存判定用的 now：必须在探针前采点（相对上次 checkedAt 判断是否过期）。
      const now = deps.now();
      const key = keyOf(input);
      if (!input.force && last && lastKey === key && now - last.checkedAt < input.ttlMs) {
        return { ...last, fromCache: true };
      }

      const domains = await probeHosts(input.hosts, deps.probeDomain, input.allowedRegions);

      // checkedAt 应取探针完成时刻，TTL 从结果产生时起算，避免慢探针白耗有效期。
      const result: GuardResult = {
        verdict: aggregateVerdict(domains),
        domains,
        checkedAt: deps.now(),
        fromCache: false,
      };
      last = result;
      lastKey = key;
      return result;
    },
  };
}
