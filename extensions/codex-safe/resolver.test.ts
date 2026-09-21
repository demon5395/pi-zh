import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import {
  HOST_DOCKER_INTERNAL,
  isContainer,
  defaultResolveHost,
  resolveProxyUrl,
} from "./resolver";

/** 测试用宿主解析：始终返回一个假地址 */
const resolves = () => vi.fn(async () => "192.168.65.254");
/** 测试用宿主解析：模拟 host.docker.internal 不可解析 */
const unresolvable = () => vi.fn(async () => null);

/** 容器内回环改写后的期望运行时地址（`URL` 重建会规范化，如补尾随 `/`） */
const runtimeUrl = (input: string): string => {
  const u = new URL(input);
  u.hostname = HOST_DOCKER_INTERNAL;
  return u.href;
};

describe("isContainer", () => {
  it("默认检查 /.dockerenv", () => {
    expect(isContainer()).toBe(fs.existsSync("/.dockerenv"));
  });
});

describe("defaultResolveHost", () => {
  it("可解析的宿主返回地址，不可解析返回 null（不抛错）", async () => {
    // 注入 lookup，避免单元测试依赖真实 DNS。
    expect(await defaultResolveHost("host.docker.internal", async () => ({ address: "192.168.65.254" }))).toBe(
      "192.168.65.254",
    );
    expect(
      await defaultResolveHost("host.docker.internal", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBeNull();
  });
});

describe("resolveProxyUrl 宿主机 / 非容器", () => {
  it("非容器下回环地址保持原值，不改写、不解析宿主、无 warning", async () => {
    const resolveHost = resolves();
    const r = await resolveProxyUrl("http://127.0.0.1:7890", {
      isContainer: () => false,
      resolveHost,
    });
    expect(r).toEqual({
      ok: true,
      original: "http://127.0.0.1:7890",
      runtime: "http://127.0.0.1:7890",
      rewritten: false,
    });
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("非容器下 localhost 与 [::1] 也保持原值", async () => {
    for (const url of ["http://localhost:7890", "http://[::1]:7890"]) {
      const r = await resolveProxyUrl(url, { isContainer: () => false });
      expect(r).toMatchObject({ ok: true, runtime: url, rewritten: false });
    }
  });

  it("容器内非回环主机不改写", async () => {
    const resolveHost = resolves();
    const r = await resolveProxyUrl("http://proxy.example.com:8080", {
      isContainer: () => true,
      resolveHost,
    });
    expect(r).toEqual({
      ok: true,
      original: "http://proxy.example.com:8080",
      runtime: "http://proxy.example.com:8080",
      rewritten: false,
    });
    expect(resolveHost).not.toHaveBeenCalled();
  });
});

describe("resolveProxyUrl 容器内回环改写", () => {
  it("127.0.0.1 改写为 host.docker.internal", async () => {
    const input = "http://127.0.0.1:7890";
    const r = await resolveProxyUrl(input, {
      isContainer: () => true,
      resolveHost: resolves(),
    });
    expect(r).toEqual({
      ok: true,
      original: input,
      runtime: runtimeUrl(input),
      rewritten: true,
    });
  });

  it("localhost（大小写不敏感）改写为 host.docker.internal", async () => {
    const input = "http://LocalHost:7890";
    const r = await resolveProxyUrl(input, {
      isContainer: () => true,
      resolveHost: resolves(),
    });
    expect(r).toMatchObject({ ok: true, runtime: runtimeUrl(input), rewritten: true });
  });

  it("IPv6 回环 [::1] 改写为 host.docker.internal", async () => {
    const input = "http://[::1]:7890";
    const r = await resolveProxyUrl(input, {
      isContainer: () => true,
      resolveHost: resolves(),
    });
    expect(r).toMatchObject({ ok: true, runtime: runtimeUrl(input), rewritten: true });
  });

  it("省略 // 的 http:127.0.0.1:7890 也会真正改写（回归：rewritten 与 runtime 一致）", async () => {
    const input = "http:127.0.0.1:7890";
    const r = await resolveProxyUrl(input, {
      isContainer: () => true,
      resolveHost: resolves(),
    });
    expect(r).toEqual({
      ok: true,
      original: input,
      runtime: runtimeUrl(input),
      rewritten: true,
    });
    if (r.ok) {
      // rewritten 为真时，runtime 必须实际改写了主机，且原始字符串保持不变。
      expect(new URL(r.runtime).hostname).toBe(HOST_DOCKER_INTERNAL);
      expect(r.runtime).not.toBe(r.original);
    }
  });

  it("所有回环写法的 rewritten 与 runtime 主机变化保持一致", async () => {
    const inputs = [
      "http:127.0.0.1:7890",
      "http:localhost:7890",
      "https:127.0.0.1:8443/a/b?c=d#e",
      "http://127.0.0.1:7890",
      "http://[::1]:7890",
      "http://user:pass@127.0.0.1:7890/proxy",
    ];
    for (const input of inputs) {
      const r = await resolveProxyUrl(input, { isContainer: () => true, resolveHost: resolves() });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.rewritten).toBe(true);
        expect(r.runtime).not.toBe(r.original);
        expect(new URL(r.runtime).hostname).toBe(HOST_DOCKER_INTERNAL);
      }
    }
  });

  it("保留协议、端口、认证信息、pathname/query/hash", async () => {
    const r = await resolveProxyUrl("https://user:pass@127.0.0.1:8443/a/b?c=d#e", {
      isContainer: () => true,
      resolveHost: resolves(),
    });
    expect(r).toMatchObject({
      ok: true,
      original: "https://user:pass@127.0.0.1:8443/a/b?c=d#e",
      runtime: `https://user:pass@${HOST_DOCKER_INTERNAL}:8443/a/b?c=d#e`,
      rewritten: true,
    });
  });

  it("host.docker.internal 无法解析 → 报告 warning，不回退直连", async () => {
    const r = await resolveProxyUrl("http://127.0.0.1:7890", {
      isContainer: () => true,
      resolveHost: unresolvable(),
    });
    expect(r).toMatchObject({ ok: true, rewritten: true });
    if (r.ok) {
      expect(r.runtime).toBe(runtimeUrl("http://127.0.0.1:7890"));
      expect(r.warning).toContain(HOST_DOCKER_INTERNAL);
      expect(r.warning).toContain("extra_hosts");
    }
  });

  it("宿主可解析时无 warning", async () => {
    const r = await resolveProxyUrl("http://127.0.0.1:7890", {
      isContainer: () => true,
      resolveHost: resolves(),
    });
    expect(r.ok && r.warning).toBeUndefined();
  });
});

describe("resolveProxyUrl 非法 URL", () => {
  it("返回结构化错误并保留原始字符串", async () => {
    for (const bad of ["", "not a url", "127.0.0.1:7890", "ftp://127.0.0.1"]) {
      const r = await resolveProxyUrl(bad, { isContainer: () => true });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.original).toBe(bad);
        expect(r.error.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("resolveProxyUrl 不写回配置", () => {
  it("返回的 original 与输入完全一致，runtime 为独立字符串", async () => {
    const input = "http://127.0.0.1:7890";
    const r = await resolveProxyUrl(input, { isContainer: () => true, resolveHost: resolves() });
    expect(r.original).toBe(input);
    if (r.ok) expect(r.runtime).not.toBe(input);
    // 输入原始字符串不可变（JS 字符串本身不可变），且无文件写入面
    expect(input).toBe("http://127.0.0.1:7890");
  });
});
