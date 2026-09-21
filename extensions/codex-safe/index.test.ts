import { describe, it, expect } from "vitest";
import { describe as d3, it as it3, expect as e3, vi } from "vitest";
import {
  describeProxyStatus,
  formatDoctorReport,
  formatProxyResolution,
  handleInputGate,
  periodicRecheck,
  resolveEffectiveProxyResolution,
} from "./index";
import type { GateDeps, PeriodicRecheckDeps } from "./index";
import type { DomainVerdict } from "./judge";
import { HOST_DOCKER_INTERNAL, resolveProxyUrl } from "./resolver";

/** 容器内可解析 host.docker.internal 的宿主解析桩 */
const hostResolves = async () => "192.168.65.254";
/** 容器内无法解析 host.docker.internal 的宿主解析桩 */
const hostUnresolvable = async () => null;

const v = (host: string, verdict: DomainVerdict["verdict"], notes: string[] = []): DomainVerdict => ({
  host,
  verdict,
  reason: "reason",
  proxied: { ip: "1.1.1.1", loc: "JP", colo: "NRT" },
  direct: { ip: "9.9.9.9", loc: "CN", colo: undefined },
  notes,
});

describe("formatDoctorReport", () => {
  it("含整体判定、每个哨兵域名、两路 IP 与地区", () => {
    const s = formatDoctorReport([v("chatgpt.com", "SAFE"), v("api.openai.com", "LEAK")], "LEAK");
    expect(s).toContain("chatgpt.com");
    expect(s).toContain("api.openai.com");
    expect(s).toContain("1.1.1.1");
    expect(s).toContain("9.9.9.9");
    expect(s).toContain("JP");
    expect(s).toContain("CN");
    expect(s).toContain("危险：未走代理");
  });

  it("notes 会出现在报告里", () => {
    const s = formatDoctorReport([v("h", "SAFE", ["直连探针不可用（timeout），LEAK 判据不可用"])], "SAFE");
    expect(s).toContain("LEAK 判据不可用");
  });

  it("单行输出不含裸换行以外的控制字符，可安全进 notify", () => {
    const s = formatDoctorReport([v("h", "SAFE")], "SAFE");
    expect(s).not.toMatch(/[\r\t]/);
  });
});

describe("describeProxyStatus", () => {
  it("区分「配置文件值」与「当前进程生效值」", () => {
    const s = describeProxyStatus({
      configured: "http://127.0.0.1:7890",
      desired: "http://127.0.0.1:7890",
      effective: { value: "http://127.0.0.1:7890", source: "HTTP_PROXY" },
    });
    expect(s).toContain("配置");
    expect(s).toContain("HTTP_PROXY");
    expect(s).toContain("一致");
  });

  it("配置值缺失时明确说明未设置", () => {
    const s = describeProxyStatus({
      configured: undefined,
      desired: "http://127.0.0.1:7890",
      effective: { source: "none" },
    });
    expect(s).toContain("未设置");
  });

  it("进程生效值与配置值不一致时给出警告与原因", () => {
    const s = describeProxyStatus({
      configured: "http://127.0.0.1:7890",
      desired: "http://127.0.0.1:7890",
      effective: { value: "http://127.0.0.1:1080", source: "HTTP_PROXY" },
    });
    expect(s).toContain("不一致");
    expect(s).toContain("HTTP_PROXY");
  });
});

describe("formatProxyResolution", () => {
  it("容器内回环代理：展示原始 URL、运行时 URL、改写提示与启动配置错误", async () => {
    const res = await resolveProxyUrl("http://127.0.0.1:7890", {
      isContainer: () => true,
      resolveHost: hostResolves,
    });
    const s = formatProxyResolution(res);
    expect(s).toContain("http://127.0.0.1:7890");
    expect(s).toContain(HOST_DOCKER_INTERNAL);
    expect(s).toContain("改写");
    expect(s).toContain("启动配置错误");
  });

  it("宿主机（非容器）回环代理：原样展示且不报启动配置错误", async () => {
    const res = await resolveProxyUrl("http://127.0.0.1:7890", { isContainer: () => false });
    const s = formatProxyResolution(res);
    expect(s).toContain("http://127.0.0.1:7890");
    expect(s).not.toContain(HOST_DOCKER_INTERNAL);
    expect(s).not.toContain("启动配置错误");
  });

  it("容器内非回环代理：不改写且不报启动配置错误", async () => {
    const res = await resolveProxyUrl("http://proxy.example.com:8080", {
      isContainer: () => true,
      resolveHost: hostResolves,
    });
    const s = formatProxyResolution(res);
    expect(s).toContain("http://proxy.example.com:8080");
    expect(s).not.toContain(HOST_DOCKER_INTERNAL);
    expect(s).not.toContain("启动配置错误");
  });

  it("host.docker.internal 不可解析：诊断展示 extra_hosts 排查提示", async () => {
    const res = await resolveProxyUrl("http://127.0.0.1:7890", {
      isContainer: () => true,
      resolveHost: hostUnresolvable,
    });
    const s = formatProxyResolution(res);
    expect(s).toContain("extra_hosts");
  });

  it("非法 URL：展示原始地址与解析失败", async () => {
    const res = await resolveProxyUrl("not a url", { isContainer: () => true });
    const s = formatProxyResolution(res);
    expect(s).toContain("not a url");
    expect(s).toContain("解析失败");
  });
});

describe("describeProxyStatus 容器解析", () => {
  it("容器内 127.0.0.1 配置：展示原始/运行时地址与改写提示", async () => {
    const effectiveResolution = await resolveProxyUrl("http://127.0.0.1:7890", {
      isContainer: () => true,
      resolveHost: hostResolves,
    });
    const s = describeProxyStatus({
      configured: "http://127.0.0.1:7890",
      desired: "http://127.0.0.1:7890",
      effective: { value: "http://127.0.0.1:7890", source: "HTTP_PROXY" },
      effectiveResolution,
    });
    expect(s).toContain("http://127.0.0.1:7890");
    expect(s).toContain(HOST_DOCKER_INTERNAL);
    expect(s).toContain("改写");
  });

  it("未提供解析结果时保持原有文案（向后兼容）", () => {
    const s = describeProxyStatus({
      configured: "http://127.0.0.1:7890",
      desired: "http://127.0.0.1:7890",
      effective: { value: "http://127.0.0.1:7890", source: "HTTP_PROXY" },
    });
    expect(s).toContain("配置值与进程生效值一致");
    expect(s).not.toContain(HOST_DOCKER_INTERNAL);
  });

  it("进程无生效代理但已配置：说明需重启且不误报容器改写", () => {
    const s = describeProxyStatus({
      configured: "http://127.0.0.1:7890",
      desired: "http://127.0.0.1:7890",
      effective: { source: "none" },
    });
    expect(s).toContain("尚未生效");
    expect(s).not.toContain(HOST_DOCKER_INTERNAL);
  });
});

describe("resolveEffectiveProxyResolution", () => {
  it("容器内 HTTP_PROXY 为回环：解析为 host.docker.internal 运行时地址", async () => {
    const r = await resolveEffectiveProxyResolution(
      { HTTP_PROXY: "http://127.0.0.1:7890" },
      { isContainer: () => true, resolveHost: hostResolves },
    );
    expect(r?.ok).toBe(true);
    if (r?.ok) {
      expect(r.original).toBe("http://127.0.0.1:7890");
      expect(new URL(r.runtime).hostname).toBe(HOST_DOCKER_INTERNAL);
      expect(r.rewritten).toBe(true);
    }
  });

  it("环境变量优先级：HTTP_PROXY 优先于 HTTPS_PROXY", async () => {
    const r = await resolveEffectiveProxyResolution(
      { HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://proxy.example.com:8443" },
      { isContainer: () => true, resolveHost: hostResolves },
    );
    expect(r?.ok && r.original).toBe("http://127.0.0.1:7890");
  });

  it("无任何生效代理 → undefined", async () => {
    const r = await resolveEffectiveProxyResolution({}, { isContainer: () => true });
    expect(r).toBeUndefined();
  });

  it("非容器环境：回环代理原样返回", async () => {
    const r = await resolveEffectiveProxyResolution(
      { HTTPS_PROXY: "http://127.0.0.1:7890" },
      { isContainer: () => false },
    );
    expect(r?.ok && r.runtime).toBe("http://127.0.0.1:7890");
    expect(r?.ok && r.rewritten).toBe(false);
  });
});

describe("formatDoctorReport 代理线路", () => {
  it("提供解析结果时附带代理原始/运行时地址", async () => {
    const effectiveResolution = await resolveProxyUrl("http://127.0.0.1:7890", {
      isContainer: () => true,
      resolveHost: hostResolves,
    });
    const s = formatDoctorReport([v("chatgpt.com", "SAFE")], "SAFE", effectiveResolution);
    expect(s).toContain("http://127.0.0.1:7890");
    expect(s).toContain(HOST_DOCKER_INTERNAL);
    expect(s).toContain("改写");
  });

  it("未提供解析结果时保持原有报告格式", () => {
    const s = formatDoctorReport([v("chatgpt.com", "SAFE")], "SAFE");
    expect(s).not.toContain(HOST_DOCKER_INTERNAL);
  });
});

const SAFE = { verdict: "SAFE" as const, domains: [], checkedAt: 0, fromCache: false };
const LEAK = { verdict: "LEAK" as const, domains: [], checkedAt: 0, fromCache: false };

function gateDeps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    enabled: true,
    isCodexModel: true,
    hasUI: true,
    source: "interactive",
    isIdle: true,
    text: "hello",
    noUiPolicy: "warn",
    check: async () => SAFE,
    confirm: async () => "continue",
    notify: () => {},
    now: () => 0,
    ...over,
  };
}

d3("handleInputGate", () => {
  it3("非 codex 模型 → 放行且不探针", async () => {
    const check = vi.fn(async () => SAFE);
    const r = await handleInputGate(gateDeps({ isCodexModel: false, check }));
    e3(r.action).toBe("continue");
    e3(check).not.toHaveBeenCalled();
  });

  it3("enabled=false → 放行且不探针", async () => {
    const check = vi.fn(async () => SAFE);
    const r = await handleInputGate(gateDeps({ enabled: false, check }));
    e3(r.action).toBe("continue");
    e3(check).not.toHaveBeenCalled();
  });

  it3("斜杠命令 → 放行且不探针", async () => {
    const check = vi.fn(async () => SAFE);
    const r = await handleInputGate(gateDeps({ text: "/model", check }));
    e3(r.action).toBe("continue");
    e3(check).not.toHaveBeenCalled();
  });

  it3("source=extension → 放行且不探针", async () => {
    const check = vi.fn(async () => SAFE);
    const r = await handleInputGate(gateDeps({ source: "extension", check }));
    e3(r.action).toBe("continue");
    e3(check).not.toHaveBeenCalled();
  });

  it3("非空闲（轮内续写）→ 放行（交给周期复检兜底）", async () => {
    const check = vi.fn(async () => SAFE);
    const r = await handleInputGate(gateDeps({ isIdle: false, check }));
    e3(r.action).toBe("continue");
    e3(check).not.toHaveBeenCalled();
  });

  it3("SAFE → 放行", async () => {
    const r = await handleInputGate(gateDeps());
    e3(r.action).toBe("continue");
  });

  it3("LEAK + 有 UI + 选「中止」→ handled", async () => {
    const r = await handleInputGate(gateDeps({ check: async () => LEAK, confirm: async () => "abort" }));
    e3(r.action).toBe("handled");
  });

  it3("LEAK + 有 UI + 选「继续」→ continue（仅本次豁免）", async () => {
    const r = await handleInputGate(gateDeps({ check: async () => LEAK, confirm: async () => "continue" }));
    e3(r.action).toBe("continue");
  });

  it3("LEAK + 有 UI + Esc（undefined）→ 按安全默认 handled", async () => {
    const r = await handleInputGate(gateDeps({ check: async () => LEAK, confirm: async () => undefined }));
    e3(r.action).toBe("handled");
  });

  it3("LEAK + 无 UI + noUiPolicy=warn → 放行并警示", async () => {
    const notify = vi.fn();
    const r = await handleInputGate(
      gateDeps({ hasUI: false, check: async () => LEAK, noUiPolicy: "warn", notify }),
    );
    e3(r.action).toBe("continue");
    e3(notify).toHaveBeenCalled();
  });

  it3("LEAK + 无 UI + noUiPolicy=block → handled 并警示", async () => {
    const notify = vi.fn();
    const r = await handleInputGate(
      gateDeps({ hasUI: false, check: async () => LEAK, noUiPolicy: "block", notify }),
    );
    e3(r.action).toBe("handled");
    e3(notify).toHaveBeenCalled();
  });

  it3("探针抛错 → 按 UNKNOWN 处理（= 非 SAFE），绝不静默放行", async () => {
    const r = await handleInputGate(
      gateDeps({
        check: async () => {
          throw new Error("boom");
        },
        confirm: async () => "abort",
      }),
    );
    e3(r.action).toBe("handled");
  });

  it3("探针抛错 + 无 UI + noUiPolicy=warn → 复用非 SAFE 分支：放行并警示", async () => {
    const notify = vi.fn();
    const r = await handleInputGate(
      gateDeps({
        hasUI: false,
        noUiPolicy: "warn",
        notify,
        check: async () => {
          throw new Error("boom");
        },
      }),
    );
    e3(r.action).toBe("continue");
    e3(notify).toHaveBeenCalled();
  });
});

function recheckDeps(over: Partial<PeriodicRecheckDeps> = {}): PeriodicRecheckDeps {
  return {
    enabled: true,
    isCodexModel: true,
    ignoreTurn: () => false,
    isIdle: () => true,
    check: async () => SAFE,
    setStatus: () => {},
    notify: () => {},
    abort: () => {},
    ...over,
  };
}

d3("periodicRecheck", () => {
  it3("enabled=false → 不探针、不动状态行", async () => {
    const check = vi.fn(async () => SAFE);
    const setStatus = vi.fn();
    await periodicRecheck(recheckDeps({ enabled: false, check, setStatus }));
    e3(check).not.toHaveBeenCalled();
    e3(setStatus).not.toHaveBeenCalled();
  });

  it3("非 codex → 清状态行且不探针", async () => {
    const check = vi.fn(async () => SAFE);
    const setStatus = vi.fn();
    await periodicRecheck(recheckDeps({ isCodexModel: false, check, setStatus }));
    e3(check).not.toHaveBeenCalled();
    e3(setStatus).toHaveBeenCalledWith(undefined);
  });

  it3("SAFE → 清状态行、不中止", async () => {
    const setStatus = vi.fn();
    const abort = vi.fn();
    await periodicRecheck(recheckDeps({ setStatus, abort }));
    e3(setStatus).toHaveBeenCalledWith(undefined);
    e3(abort).not.toHaveBeenCalled();
  });

  it3("非 SAFE + 空闲 → 仅写状态行，不中止", async () => {
    const setStatus = vi.fn();
    const abort = vi.fn();
    await periodicRecheck(recheckDeps({ check: async () => LEAK, setStatus, abort }));
    e3(setStatus).toHaveBeenCalledWith(expect.stringContaining("危险：未走代理"));
    e3(abort).not.toHaveBeenCalled();
  });

  it3("非 SAFE + 运行中 → 警示并中止", async () => {
    const notify = vi.fn();
    const abort = vi.fn();
    await periodicRecheck(recheckDeps({ check: async () => LEAK, isIdle: () => false, notify, abort }));
    e3(notify).toHaveBeenCalled();
    e3(abort).toHaveBeenCalledOnce();
  });

  it3("非 SAFE + 运行中但本轮已豁免 → 不中止（仍警示）", async () => {
    const setStatus = vi.fn();
    const abort = vi.fn();
    await periodicRecheck(
      recheckDeps({ check: async () => LEAK, isIdle: () => false, ignoreTurn: () => true, setStatus, abort }),
    );
    e3(setStatus).toHaveBeenCalledWith(expect.stringContaining("危险：未走代理"));
    e3(abort).not.toHaveBeenCalled();
  });

  it3("check 抛错 → 兜底告知且不 reject（复检不静默死掉）", async () => {
    const notify = vi.fn();
    await e3(
      periodicRecheck(
        recheckDeps({
          check: async () => {
            throw new Error("boom");
          },
          notify,
        }),
      ),
    ).resolves.toBeUndefined();
    e3(notify).toHaveBeenCalledWith(expect.stringContaining("boom"), "error");
  });

  it3("setStatus 抛错 → 兜底告知且不 reject", async () => {
    const notify = vi.fn();
    await e3(
      periodicRecheck(
        recheckDeps({
          setStatus: () => {
            throw new Error("ui down");
          },
          notify,
        }),
      ),
    ).resolves.toBeUndefined();
    e3(notify).toHaveBeenCalledWith(expect.stringContaining("ui down"), "error");
  });
});
