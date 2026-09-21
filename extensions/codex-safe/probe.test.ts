import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import {
  defaultHttpsGet,
  parseTrace,
  probeDirect,
  probeProxied,
  traceUrl,
} from "./probe";

const { httpsGetMock } = vi.hoisted(() => ({ httpsGetMock: vi.fn() }));

vi.mock("node:https", () => ({ default: { get: httpsGetMock } }));

/** 构造一个「响应头已到、body 传输中途 emit error」的 node:https mock */
function mockMidBodyError(err: Error): void {
  httpsGetMock.mockImplementationOnce(
    (_url: string, _opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      setImmediate(() => {
        res.emit("data", Buffer.from("ip=1.2.3.4\n"));
        res.emit("error", err);
      });
      cb(res);
      return Object.assign(new EventEmitter(), { destroy: vi.fn() });
    },
  );
}

const res = (status: number, body: string) => ({ status, text: async () => body });
const TRACE = "fl=abc\nip=203.0.113.7\nts=1\nloc=JP\ncolo=NRT\n";

describe("parseTrace", () => {
  it("解析 ip/loc/colo", () => {
    expect(parseTrace(TRACE)).toEqual({ ip: "203.0.113.7", loc: "JP", colo: "NRT" });
  });
  it("缺 ip 或 loc → null", () => {
    expect(parseTrace("ip=1.2.3.4\n")).toBeNull();
    expect(parseTrace("loc=JP\n")).toBeNull();
    expect(parseTrace("")).toBeNull();
  });
});

describe("traceUrl", () => {
  it("拼出同域名 trace 地址", () => {
    expect(traceUrl("chatgpt.com")).toBe("https://chatgpt.com/cdn-cgi/trace");
  });
});

describe("probeProxied", () => {
  it("200 + 合法 trace → ok", async () => {
    const r = await probeProxied("chatgpt.com", { fetchImpl: async () => res(200, TRACE) });
    expect(r).toEqual({ ok: true, info: { ip: "203.0.113.7", loc: "JP", colo: "NRT" } });
  });
  it("非 200 → ok:false 且带状态码", async () => {
    const r = await probeProxied("chatgpt.com", { fetchImpl: async () => res(403, "") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("403");
  });
  it("抛错 → ok:false 且不抛异常", async () => {
    const r = await probeProxied("chatgpt.com", {
      fetchImpl: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ENOTFOUND");
  });
  it("超时 → ok:false", async () => {
    const r = await probeProxied("chatgpt.com", {
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    expect(r.ok).toBe(false);
  });
});

describe("probeDirect", () => {
  it("走注入的 node:https 实现（不与 proxied 共用通道）", async () => {
    let seenUrl = "";
    const r = await probeDirect("auth.openai.com", {
      httpsGetImpl: async (url) => {
        seenUrl = url;
        return res(200, "ip=1.2.3.4\nloc=CN\n");
      },
    });
    expect(seenUrl).toBe("https://auth.openai.com/cdn-cgi/trace");
    expect(r).toEqual({ ok: true, info: { ip: "1.2.3.4", loc: "CN", colo: undefined } });
  });

  it("响应流中途 emit error → Promise reject（不抛未捕获异常）", async () => {
    mockMidBodyError(new Error("ECONNRESET mid-body"));
    await expect(
      defaultHttpsGet("https://auth.openai.com/cdn-cgi/trace", { timeoutMs: 1000 }),
    ).rejects.toThrow("ECONNRESET mid-body");
  });

  it("probeDirect：响应流中途断连 → 收敛为 {ok:false}", async () => {
    mockMidBodyError(new Error("ECONNRESET mid-body"));
    const r = await probeDirect("auth.openai.com", { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ECONNRESET mid-body");
  });

  it("响应流正常 end → resolve（error 监听不影响正常路径）", async () => {
    httpsGetMock.mockImplementationOnce(
      (_url: string, _opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        setImmediate(() => {
          res.emit("data", Buffer.from("ip=1.2.3.4\nloc=CN\n"));
          res.emit("end");
        });
        cb(res);
        return Object.assign(new EventEmitter(), { destroy: vi.fn() });
      },
    );
    const r = await defaultHttpsGet("https://auth.openai.com/cdn-cgi/trace", {
      timeoutMs: 1000,
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("loc=CN");
  });
});
