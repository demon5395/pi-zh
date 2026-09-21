import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig, saveConfig } from "./config";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig / saveConfig", () => {
  it("缺失文件 → 默认配置，无 warning", () => {
    const r = loadConfig(dir);
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.warnings).toEqual([]);
  });

  it("往返一致，无 tmp 残留", () => {
    saveConfig(dir, { ...DEFAULT_CONFIG, cacheTtlMs: 30000, proxyUrl: "http://127.0.0.1:1080" });
    const r = loadConfig(dir);
    expect(r.warnings).toEqual([]);
    expect(r.config.cacheTtlMs).toBe(30000);
    expect(r.config.proxyUrl).toBe("http://127.0.0.1:1080");
    expect(fs.readdirSync(dir)).toEqual([CONFIG_FILENAME]);
  });

  it("写入权限 0600", () => {
    saveConfig(dir, DEFAULT_CONFIG);
    expect(fs.statSync(path.join(dir, CONFIG_FILENAME)).mode & 0o777).toBe(0o600);
  });

  it("损坏 JSON → 默认配置 + warning", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), "{bad");
    const r = loadConfig(dir);
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("坏字段逐项回退默认并告警：类型错、数字 <=0、枚举非法", () => {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({
        enabled: "yes",
        cacheTtlMs: -1,
        noUiPolicy: "explode",
        probeTimeoutMs: "slow",
      }),
    );
    const r = loadConfig(dir);
    expect(r.config.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(r.config.cacheTtlMs).toBe(DEFAULT_CONFIG.cacheTtlMs);
    expect(r.config.noUiPolicy).toBe(DEFAULT_CONFIG.noUiPolicy);
    expect(r.config.probeTimeoutMs).toBe(DEFAULT_CONFIG.probeTimeoutMs);
    expect(r.warnings.length).toBeGreaterThanOrEqual(4);
  });

  it("sentinels/allowedRegions：非数组或空数组回退默认", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify({ sentinels: [], allowedRegions: "US" }));
    const r = loadConfig(dir);
    expect(r.config.sentinels).toEqual([...DEFAULT_CONFIG.sentinels]);
    expect(r.config.allowedRegions).toEqual([...DEFAULT_CONFIG.allowedRegions]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("数组内的非字符串项被丢弃", () => {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({ sentinels: ["a.com", 42, null, "b.com"] }),
    );
    const r = loadConfig(dir);
    expect(r.config.sentinels).toEqual(["a.com", "b.com"]);
  });

  it("原型污染键被丢弃", () => {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      '{"__proto__":{"polluted":true},"cacheTtlMs":20000}',
    );
    const r = loadConfig(dir);
    expect(({} as any).polluted).toBeUndefined();
    expect(r.config.cacheTtlMs).toBe(20000);
  });
});
