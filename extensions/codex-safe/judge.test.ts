import { describe, it, expect } from "vitest";
import { aggregateVerdict, judgeDomain, verdictLabel } from "./judge";
import type { ProbeOutcome } from "./probe";
import { DEFAULT_ALLOWED_REGIONS } from "./hosts";

const ok = (ip: string, loc: string): ProbeOutcome => ({ ok: true, info: { ip, loc } });
const bad = (reason: string): ProbeOutcome => ({ ok: false, reason });

const judge = (proxied: ProbeOutcome, direct: ProbeOutcome, allowedRegions = DEFAULT_ALLOWED_REGIONS) =>
  judgeDomain({ host: "chatgpt.com", proxied, direct, allowedRegions });

describe("judgeDomain", () => {
  it("代理与直连 IP 不同且地区受支持 → SAFE", () => {
    expect(judge(ok("1.1.1.1", "JP"), ok("9.9.9.9", "CN")).verdict).toBe("SAFE");
  });

  it("代理与直连 IP 相同 → LEAK（规则未命中）", () => {
    const r = judge(ok("9.9.9.9", "CN"), ok("9.9.9.9", "CN"));
    expect(r.verdict).toBe("LEAK");
    expect(r.reason).toContain("9.9.9.9");
  });

  it("走了代理但地区不在白名单 → REGION", () => {
    expect(judge(ok("1.1.1.1", "HK"), ok("9.9.9.9", "CN")).verdict).toBe("REGION");
  });

  it("代理探针失败 → UNKNOWN（不静默放行）", () => {
    expect(judge(bad("timeout"), ok("9.9.9.9", "CN")).verdict).toBe("UNKNOWN");
  });

  it("直连探针失败但代理地区受支持 → SAFE，且标注 LEAK 判据不可用", () => {
    const r = judge(ok("1.1.1.1", "US"), bad("ECONNREFUSED"));
    expect(r.verdict).toBe("SAFE");
    expect(r.notes.join(" ")).toContain("LEAK 判据不可用");
  });

  it("直连探针失败且代理地区不受支持 → REGION", () => {
    expect(judge(ok("1.1.1.1", "HK"), bad("timeout")).verdict).toBe("REGION");
  });

  it('allowedRegions=["*"] 时跳过地区校验，但 LEAK 仍然优先', () => {
    expect(judge(ok("1.1.1.1", "HK"), ok("9.9.9.9", "CN"), ["*"]).verdict).toBe("SAFE");
    expect(judge(ok("9.9.9.9", "HK"), ok("9.9.9.9", "CN"), ["*"]).verdict).toBe("LEAK");
  });

  it("LEAK 优先于 REGION（同 IP 且地区不受支持仍是 LEAK）", () => {
    expect(judge(ok("9.9.9.9", "CN"), ok("9.9.9.9", "CN")).verdict).toBe("LEAK");
  });
});

describe("aggregateVerdict", () => {
  const d = (verdict: any) => ({ host: "h", verdict, reason: "", notes: [] });
  it("取最差：LEAK > REGION > UNKNOWN > SAFE", () => {
    expect(aggregateVerdict([d("SAFE"), d("REGION"), d("SAFE")])).toBe("REGION");
    expect(aggregateVerdict([d("SAFE"), d("UNKNOWN")])).toBe("UNKNOWN");
    expect(aggregateVerdict([d("SAFE"), d("LEAK")])).toBe("LEAK");
    expect(aggregateVerdict([d("REGION"), d("LEAK")])).toBe("LEAK");
  });
  it("全 SAFE → SAFE", () => {
    expect(aggregateVerdict([d("SAFE"), d("SAFE")])).toBe("SAFE");
  });
  it("空列表 → UNKNOWN（不能凭空集合宣称安全）", () => {
    expect(aggregateVerdict([])).toBe("UNKNOWN");
  });
});

describe("verdictLabel", () => {
  it("四态都有中文标签", () => {
    for (const v of ["SAFE", "LEAK", "REGION", "UNKNOWN"] as const) {
      expect(verdictLabel(v).length).toBeGreaterThan(0);
    }
  });
});
