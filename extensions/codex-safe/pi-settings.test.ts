import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearHttpProxy,
  isValidProxyUrl,
  readHttpProxy,
  resolveEffectiveProxy,
  setHttpProxy,
} from "./pi-settings";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "piset-"));
  file = path.join(dir, "settings.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("isValidProxyUrl", () => {
  it("接受 http/https 带 host:port", () => {
    expect(isValidProxyUrl("http://127.0.0.1:7890")).toBe(true);
    expect(isValidProxyUrl("https://proxy.example.com:443")).toBe(true);
  });
  it("拒绝其它协议与畸形输入", () => {
    expect(isValidProxyUrl("socks5://127.0.0.1:7890")).toBe(false);
    expect(isValidProxyUrl("127.0.0.1:7890")).toBe(false);
    expect(isValidProxyUrl("")).toBe(false);
  });
});

describe("setHttpProxy / readHttpProxy / clearHttpProxy", () => {
  it("文件不存在时创建，并保留其它字段", () => {
    fs.writeFileSync(file, JSON.stringify({ theme: "dark", packages: ["npm:x"] }, null, 2));
    const r = setHttpProxy(file, "http://127.0.0.1:7890");
    expect(r.changed).toBe(true);
    expect(r.hadField).toBe(false);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.theme).toBe("dark");
    expect(after.packages).toEqual(["npm:x"]);
    expect(after.httpProxy).toBe("http://127.0.0.1:7890");
    expect(readHttpProxy(file)).toBe("http://127.0.0.1:7890");
  });

  it("写前生成备份，且备份内容为写前状态", () => {
    fs.writeFileSync(file, JSON.stringify({ theme: "dark" }));
    const r = setHttpProxy(file, "http://127.0.0.1:7890");
    expect(r.backupPath).toBe(`${file}.codex-safe.bak`);
    expect(JSON.parse(fs.readFileSync(r.backupPath!, "utf8"))).toEqual({ theme: "dark" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).httpProxy).toBe("http://127.0.0.1:7890");
  });

  it("值未变化时 changed=false 且不写盘", () => {
    fs.writeFileSync(file, JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
    const r = setHttpProxy(file, "http://127.0.0.1:7890");
    expect(r.changed).toBe(false);
    expect(r.backupPath).toBeUndefined();
  });

  it("clear 删除字段并保留其它字段；再次 clear 幂等", () => {
    fs.writeFileSync(file, JSON.stringify({ theme: "dark", httpProxy: "http://127.0.0.1:7890" }));
    expect(clearHttpProxy(file).changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ theme: "dark" });
    expect(clearHttpProxy(file).changed).toBe(false);
    expect(readHttpProxy(file)).toBeUndefined();
  });

  it("损坏 JSON → 抛错，不破坏原文件", () => {
    fs.writeFileSync(file, "{bad");
    expect(() => setHttpProxy(file, "http://127.0.0.1:7890")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{bad");
  });

  it("非法代理 URL → 抛错且不写盘", () => {
    fs.writeFileSync(file, JSON.stringify({ theme: "dark" }));
    expect(() => setHttpProxy(file, "socks5://127.0.0.1:7890")).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ theme: "dark" });
  });
});

describe("resolveEffectiveProxy", () => {
  it("识别当前进程实际生效的代理值与环境变量来源", () => {
    expect(resolveEffectiveProxy({ HTTP_PROXY: "http://127.0.0.1:7890" })).toEqual({
      value: "http://127.0.0.1:7890",
      source: "HTTP_PROXY",
    });
    expect(resolveEffectiveProxy({ HTTPS_PROXY: "http://a:1" })).toEqual({
      value: "http://a:1",
      source: "HTTPS_PROXY",
    });
    expect(resolveEffectiveProxy({}).value).toBeUndefined();
  });
});
