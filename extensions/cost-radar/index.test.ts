import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUDGET_BUS_KEY, discoverBudget } from "./budget";

/**
 * index.ts 会话生命周期单测
 *
 * 覆盖额度总线（只读闸门）在 session_start / session_shutdown / reload 下的绑定语义：
 * - 正常 /reload 序列（shutdown → start）后总线指向新实例；
 * - 同会话 id 残留总线（模拟 shutdown 未清理 / 未来 SDK 变语义）时，start 覆盖为最新实例；
 * - 不同会话 id 的总线不被覆盖（保留「同进程同 cwd 多 TUI 会话先建者拥有」既有语义）；
 * - 非 TUI / 无 UI 不发布总线。
 *
 * 本文件位于扩展深层，不参与 pi 扩展发现（扩展目录只认 index.ts 入口）。
 */

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
  on(type: string, handler: Handler): void;
  registerCommand(name: string, opts: unknown): void;
  emit(type: string, event: unknown, ctx: unknown): Promise<void>;
}

function makePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  return {
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    registerCommand() {
      // /cost 命令注册不影响本组用例
    },
    async emit(type, event, ctx) {
      for (const h of handlers.get(type) ?? []) await h(event, ctx);
    },
  };
}

function makeCtx(sessionId: string, mode = "tui", hasUI = true) {
  return {
    mode,
    hasUI,
    cwd: "/w",
    model: null,
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [],
    },
    getContextUsage: () => ({ percent: 0 }),
    getSystemPrompt: () => "",
    isIdle: () => true,
    abort: vi.fn(),
    ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(), input: vi.fn() },
  } as unknown as Record<string, unknown>;
}

let createExtension: (pi: FakePi) => void;

beforeAll(async () => {
  // 隔离配置目录，避免真实 ~/.pi/agent/cost-radar.json 影响默认预算断言
  process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cost-radar-index-test-"));
  ({ default: createExtension } = await import("./index"));
});

beforeEach(() => {
  vi.useFakeTimers(); // 心跳 setInterval 不实际触发
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>)[BUDGET_BUS_KEY];
});

describe("cost-radar 额度总线生命周期", () => {
  it("session_start 安装总线，session_shutdown 清理（正常 /reload 序列）", async () => {
    const pi = makePi();
    createExtension(pi);
    const ctx = makeCtx("s1");

    await pi.emit("session_start", { reason: "reload" }, ctx);
    const bus = discoverBudget();
    expect(bus?.ownerSessionId).toBe("s1");
    expect(bus?.check("/w").limit).toBe(5); // 出厂默认预算 ¥5

    await pi.emit("session_shutdown", { reason: "reload" }, ctx);
    expect(discoverBudget()).toBeUndefined();
  });

  it("同会话 id 残留总线时，session_start 覆盖为最新实例，check() 返回新实例实时值", async () => {
    const ctx = makeCtx("s1");

    const piOld = makePi();
    createExtension(piOld);
    await piOld.emit("session_start", { reason: "startup" }, ctx);
    const busOld = discoverBudget();
    expect(busOld).toBeDefined();
    expect(busOld!.check("/w").limit).toBe(5); // 旧实例：出厂默认预算 ¥5

    // 覆盖安装前改写磁盘配置，验证新实例 session_start 重载 → check() 反映新实例实时值
    const cfgFile = path.join(process.env.PI_CODING_AGENT_DIR!, "cost-radar.json");
    fs.writeFileSync(cfgFile, JSON.stringify({ defaultBudget: 7 }));
    try {
      // 模拟未触发 session_shutdown 的 reload：新工厂实例、同一会话 id
      const piNew = makePi();
      createExtension(piNew);
      await piNew.emit("session_start", { reason: "reload" }, ctx);

      const busNew = discoverBudget();
      expect(busNew).toBeDefined();
      expect(busNew).not.toBe(busOld); // 旧闭包不得残留
      expect(busNew?.ownerSessionId).toBe("s1");
      // getLimit 实时：新实例读到新配置 ¥7，旧实例闭包仍为 ¥5（不串台）
      expect(busNew!.check("/w").limit).toBe(7);
      expect(busOld!.check("/w").limit).toBe(5);
      // getParentSpend 实时：新实例 message_end 后 check() 读到新值，旧实例仍为 0
      await piNew.emit(
        "message_end",
        {
          message: {
            role: "assistant",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            timestamp: 1000,
          },
        },
        ctx,
      );
      expect(busNew!.check("/w").parentSpend).toBeGreaterThan(0);
      expect(busOld!.check("/w").parentSpend).toBe(0);
    } finally {
      fs.rmSync(cfgFile, { force: true });
    }
  });

  it("反序（新实例 start 先于旧实例 shutdown）时旧实例不误删新总线", async () => {
    const ctx = makeCtx("s1");

    const piOld = makePi();
    createExtension(piOld);
    await piOld.emit("session_start", { reason: "startup" }, ctx);
    expect(discoverBudget()).toBeDefined();

    // 新实例同会话覆盖安装（模拟 reload 反序：start 先到）
    const piNew = makePi();
    createExtension(piNew);
    await piNew.emit("session_start", { reason: "reload" }, ctx);
    const busNew = discoverBudget();
    expect(busNew).toBeDefined();

    // 旧实例 shutdown 后到：实例标识不匹配 → 不得删除新总线
    await piOld.emit("session_shutdown", { reason: "reload" }, ctx);
    expect(discoverBudget()).toBe(busNew);

    // 新实例自身 shutdown 才清理
    await piNew.emit("session_shutdown", { reason: "reload" }, ctx);
    expect(discoverBudget()).toBeUndefined();
  });

  it("不同会话 id 的总线不被覆盖（同 cwd 多会话先建者拥有）", async () => {
    const piOwner = makePi();
    createExtension(piOwner);
    await piOwner.emit("session_start", {}, makeCtx("s-owner"));
    const busOwner = discoverBudget();

    const piLate = makePi();
    createExtension(piLate);
    await piLate.emit("session_start", {}, makeCtx("s-late"));

    expect(discoverBudget()).toBe(busOwner);
  });

  it("非 TUI / 无 UI 不发布总线", async () => {
    const pi = makePi();
    createExtension(pi);
    await pi.emit("session_start", {}, makeCtx("s1", "rpc", false));
    expect(discoverBudget()).toBeUndefined();
  });

  it("孤儿覆盖键（已下线价格行）在 session_start 告警一次，不再静默失效", async () => {
    const cfgFile = path.join(process.env.PI_CODING_AGENT_DIR!, "cost-radar.json");
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({ priceOverrides: { "deepseek/deepseek-v4-flash-vision-exp": { inputMiss: 5 } } }),
    );
    try {
      const ctx = makeCtx("s-orphan");
      const pi = makePi();
      createExtension(pi);
      await pi.emit("session_start", {}, ctx);
      const notify = (ctx.ui as unknown as { notify: ReturnType<typeof vi.fn> }).notify;
      const msgs = notify.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes("cost-radar 配置告警") && m.includes("不在内置清单"))).toBe(true);
    } finally {
      fs.rmSync(cfgFile, { force: true });
    }
  });
});
