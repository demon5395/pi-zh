/**
 * 判定层（纯函数，零 IO）。
 *
 * 判定全表见规格 §3.2；关键优先级：LEAK 先于 REGION。
 * 设计基调：不确定时宁可 UNKNOWN（走二次确认），也不静默放行。
 */
import type { ProbeOutcome, TraceInfo } from "./probe";

export type Verdict = "SAFE" | "LEAK" | "REGION" | "UNKNOWN";

/** 聚合排序权重：数值越大越差 */
export const VERDICT_RANK: Record<Verdict, number> = {
  SAFE: 0,
  UNKNOWN: 1,
  REGION: 2,
  LEAK: 3,
};

export interface DomainVerdict {
  host: string;
  verdict: Verdict;
  /** 人类可读原因（进诊断面板与三选一文案） */
  reason: string;
  proxied?: TraceInfo;
  direct?: TraceInfo;
  /** 非致命提示，例如「LEAK 判据不可用」 */
  notes: string[];
}

export function judgeDomain(input: {
  host: string;
  proxied: ProbeOutcome;
  direct: ProbeOutcome;
  allowedRegions: readonly string[];
}): DomainVerdict {
  const { host, proxied, direct, allowedRegions } = input;
  const notes: string[] = [];
  const anyRegion = allowedRegions.includes("*");

  if (!proxied.ok) {
    return {
      host,
      verdict: "UNKNOWN",
      reason: `代理探针不可用：${proxied.reason}`,
      direct: direct.ok ? direct.info : undefined,
      notes,
    };
  }

  const p = proxied.info;
  const regionOk = anyRegion || allowedRegions.includes(p.loc);

  if (!direct.ok) {
    notes.push(`直连探针不可用（${direct.reason}），LEAK 判据不可用`);
    return {
      host,
      verdict: regionOk ? "SAFE" : "REGION",
      reason: regionOk
        ? `经代理出口 ${p.loc}（${p.ip}）`
        : `经代理出口 ${p.loc}，不在地区白名单`,
      proxied: p,
      notes,
    };
  }

  const d = direct.info;
  if (p.ip === d.ip) {
    return {
      host,
      verdict: "LEAK",
      reason: `出口 IP 与直连相同（${p.ip}），代理规则未命中`,
      proxied: p,
      direct: d,
      notes,
    };
  }

  return {
    host,
    verdict: regionOk ? "SAFE" : "REGION",
    reason: regionOk
      ? `经代理出口 ${p.loc}（${p.ip}），直连为 ${d.ip}`
      : `经代理出口 ${p.loc}（${p.ip}），不在地区白名单`,
    proxied: p,
    direct: d,
    notes,
  };
}

/** 聚合：取最差；空列表返回 UNKNOWN（不凭空集合宣称安全） */
export function aggregateVerdict(list: readonly DomainVerdict[]): Verdict {
  if (list.length === 0) return "UNKNOWN";
  let worst: Verdict = "SAFE";
  for (const item of list) {
    if (VERDICT_RANK[item.verdict] > VERDICT_RANK[worst]) worst = item.verdict;
  }
  return worst;
}

export function verdictLabel(v: Verdict): string {
  switch (v) {
    case "SAFE":
      return "安全（走代理且地区受支持）";
    case "LEAK":
      return "危险：未走代理（规则未命中）";
    case "REGION":
      return "危险：出口地区不受支持";
    case "UNKNOWN":
      return "无法判定（探针不可用）";
  }
}
