import { describe, it, expect } from "vitest";
import { createGuard, probeHosts } from "./guard";
import type { ProbeOutcome } from "./probe";

const ok = (ip: string, loc: string): ProbeOutcome => ({ ok: true, info: { ip, loc } });

function deps(seq: Array<Record<string, { proxied: ProbeOutcome; direct: ProbeOutcome }>>, clock: { t: number }) {
  let i = 0;
  return {
    calls: () => i,
    now: () => clock.t,
    probeDomain: async (host: string) => {
      const frame = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return { host, ...frame[host] };
    },
  };
}

const input = { hosts: ["chatgpt.com"], allowedRegions: ["JP"], ttlMs: 10000 };

describe("createGuard", () => {
  it("首次检查走探针并判定", async () => {
    const d = deps([{ "chatgpt.com": { proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") } }], { t: 0 });
    const g = createGuard(d);
    const r = await g.check(input);
    expect(r.verdict).toBe("SAFE");
    expect(r.fromCache).toBe(false);
    expect(d.calls()).toBe(1);
  });

  it("TTL 内命中缓存，不再探针", async () => {
    const d = deps([{ "chatgpt.com": { proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") } }], { t: 0 });
    const g = createGuard(d);
    await g.check(input);
    d.calls();
    const r2 = await g.check(input);
    expect(r2.fromCache).toBe(true);
    expect(d.calls()).toBe(1);
  });

  it("TTL 过期后重新探针", async () => {
    const frame = { "chatgpt.com": { proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") } };
    const clock = { t: 0 };
    const d = deps([frame], clock);
    const g = createGuard(d);
    await g.check(input);
    clock.t = 10001;
    const r = await g.check(input);
    expect(r.fromCache).toBe(false);
    expect(d.calls()).toBe(2);
  });

  it("force=true 跳过缓存", async () => {
    const frame = { "chatgpt.com": { proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") } };
    const clock = { t: 0 };
    const d = deps([frame], clock);
    const g = createGuard(d);
    await g.check(input);
    const r = await g.check({ ...input, force: true });
    expect(r.fromCache).toBe(false);
    expect(d.calls()).toBe(2);
  });

  it("invalidate 后立即重探", async () => {
    const frame = { "chatgpt.com": { proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") } };
    const d = deps([frame], { t: 0 });
    const g = createGuard(d);
    await g.check(input);
    g.invalidate();
    const r = await g.check(input);
    expect(r.fromCache).toBe(false);
    expect(d.calls()).toBe(2);
  });

  it("多域名结果全部保留，聚合取最差", async () => {
    const matrix = {
      "chatgpt.com": { proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") },
      "api.openai.com": { proxied: ok("9.9.9.9", "CN"), direct: ok("9.9.9.9", "CN") },
    };
    const g = createGuard(deps([matrix], { t: 0 }));
    const r = await g.check({ hosts: ["chatgpt.com", "api.openai.com"], allowedRegions: ["JP"], ttlMs: 10000 });
    expect(r.domains).toHaveLength(2);
    expect(r.verdict).toBe("LEAK");
  });

  it("TTL 从探针完成时刻起算：探测耗时不消耗有效期", async () => {
    const clock = { t: 0 };
    let i = 0;
    const d = {
      calls: () => i,
      now: () => clock.t,
      probeDomain: async (host: string) => {
        i += 1;
        // 探测期间时间推进 9000ms（如网络慢）
        clock.t += 9000;
        return { host, proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") };
      },
    };
    const g = createGuard(d);
    await g.check(input); // checkedAt 应为探针完成时刻 9000，而非发起时刻 0
    expect(d.calls()).toBe(1);

    // 距探针完成仅 1500ms，仍在 ttlMs=10000 内 → 应命中缓存
    clock.t = 10500;
    const r = await g.check(input);
    expect(r.fromCache).toBe(true);
    expect(d.calls()).toBe(1);
  });

  it("传入了不同的 hosts/allowedRegions → 缓存失效（配置变了不能吃旧结论）", async () => {
    const frame = { "chatgpt.com": { proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") } };
    const d = deps([frame], { t: 0 });
    const g = createGuard(d);
    await g.check(input);
    const r = await g.check({ ...input, allowedRegions: ["US"] });
    expect(r.fromCache).toBe(false);
    expect(r.verdict).toBe("REGION");
  });

  it("多域名并行探测：所有探针在同一 tick 内发起", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const g = createGuard({
      now: () => 0,
      probeDomain: (host: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<{ host: string; proxied: ProbeOutcome; direct: ProbeOutcome }>((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve({ host, proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") });
          });
        });
      },
    });
    const p = g.check({ hosts: ["a.com", "b.com", "c.com"], allowedRegions: ["JP"], ttlMs: 10000 });
    // 让出一个 microtask：若为串行，此刻只会发起 1 个探针
    await Promise.resolve();
    expect(maxActive).toBe(3);
    for (const release of releases) release();
    const r = await p;
    expect(r.domains).toHaveLength(3);
    expect(r.verdict).toBe("SAFE");
  });

  it("并行下单域名探针抛错只把该域名判为 UNKNOWN，不拖垮其余", async () => {
    const g = createGuard({
      now: () => 0,
      probeDomain: async (host: string) => {
        if (host === "b.com") throw new Error("boom");
        return { host, proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") };
      },
    });
    const r = await g.check({ hosts: ["a.com", "b.com", "c.com"], allowedRegions: ["JP"], ttlMs: 10000 });
    expect(r.domains).toHaveLength(3);
    expect(r.domains.map((d) => d.host)).toEqual(["a.com", "b.com", "c.com"]);
    expect(r.domains[0].verdict).toBe("SAFE");
    expect(r.domains[1].verdict).toBe("UNKNOWN");
    expect(r.domains[1].reason).toContain("boom");
    expect(r.domains[2].verdict).toBe("SAFE");
    // 聚合取最差：一个 UNKNOWN 把整体从 SAFE 拉下来
    expect(r.verdict).toBe("UNKNOWN");
  });
});

describe("probeHosts", () => {
  it("返回顺序与 hosts 一致，单域名失败隔离为 UNKNOWN", async () => {
    const domains = await probeHosts(
      ["a.com", "b.com", "c.com"],
      async (host: string) => {
        if (host === "b.com") throw new Error("timeout");
        return { host, proxied: ok("1.1.1.1", "JP"), direct: ok("9.9.9.9", "CN") };
      },
      ["JP"],
    );
    expect(domains.map((d) => d.host)).toEqual(["a.com", "b.com", "c.com"]);
    expect(domains[1].verdict).toBe("UNKNOWN");
    expect(domains[0].verdict).toBe("SAFE");
  });
});
