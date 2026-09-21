/**
 * codex-safe 扩展入口（唯一 import pi 的层）。
 *
 * 本层提供配置加载、诊断报告格式化、`/codex-safe` 命令，以及闸门接线
 * （input 硬闸 / model_select / 周期复检 / abort）。
 *
 * 运行时零 pi 依赖：pi 相关符号一律 `import type`，保证 index.test.ts 可直接导入。
 */
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { aggregateVerdict, verdictLabel } from "./judge";
import type { DomainVerdict, Verdict } from "./judge";
import { createGuard, probeHosts } from "./guard";
import type { GuardResult } from "./guard";
import { CODEX_PROVIDER_ID } from "./hosts";
import { probeDomain } from "./probe";
import { clearHttpProxy, isValidProxyUrl, readHttpProxy, resolveEffectiveProxy, setHttpProxy } from "./pi-settings";
import { HOST_DOCKER_INTERNAL, resolveProxyUrl } from "./resolver";
import type { ProxyResolution, ResolveProxyDeps } from "./resolver";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config";
import type { CodexSafeConfig } from "./config";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** 状态行 key（单一来源，避免接线与清理各写一份字面量） */
const STATUS_KEY = "codex-safe";

/**
 * 渲染代理解析结果：原始地址、运行时地址、容器改写与解析错误。
 *
 * 边界：扩展只解析/诊断/校验，不在运行期接管 pi 的全局 dispatcher。
 * 故容器内回环改写只是「运行时应当使用的地址」，当前进程实际仍用原始
 * 地址、需要启动前配置并重启；这是启动配置错误，不构成降级直连。
 */
export function formatProxyResolution(res: ProxyResolution): string {
  const lines: string[] = [`原始地址：${res.original}`];
  if (!res.ok) {
    lines.push(`解析失败：${res.error}`);
    return lines.join("\n");
  }
  lines.push(`运行时地址：${res.runtime}`);
  if (res.rewritten) {
    lines.push(`容器改写：回环地址在容器内指向容器自身、不可达，运行时需改用 ${HOST_DOCKER_INTERNAL}`);
    lines.push(
      "启动配置错误：当前进程全局代理仍是原始地址（扩展不在运行期接管 pi dispatcher），" +
        "请把 HTTP_PROXY/HTTPS_PROXY 或 settings.json 的 httpProxy 配为运行时地址后重启 pi；" +
        "扩展不会降级为直连",
    );
  }
  if (res.warning) lines.push(`警告：${res.warning}`);
  return lines.join("\n");
}

function indentBlock(text: string): string[] {
  return text.split("\n").map((l) => `  ${l}`);
}

/** 诊断报告：逐域名两路 IP/地区 + 整体判定（可选附带代理线路解析） */
export function formatDoctorReport(
  domains: readonly DomainVerdict[],
  overall: Verdict,
  proxyResolution?: ProxyResolution,
): string {
  const lines: string[] = [`codex-safe 整体判定：${verdictLabel(overall)}`];
  for (const d of domains) {
    const p = d.proxied ? `${d.proxied.ip} (${d.proxied.loc})` : "不可用";
    const dir = d.direct ? `${d.direct.ip} (${d.direct.loc})` : "不可用";
    lines.push(`  ${d.host}`);
    lines.push(`    经代理：${p}`);
    lines.push(`    直连：${dir}`);
    lines.push(`    判定：${verdictLabel(d.verdict)} — ${d.reason}`);
    for (const n of d.notes) lines.push(`    注：${n}`);
  }
  if (proxyResolution) {
    lines.push("代理线路：");
    lines.push(...indentBlock(formatProxyResolution(proxyResolution)));
  }
  return lines.join("\n");
}

/**
 * 解析「当前进程实际生效的代理」为容器运行时地址。
 *
 * 仅当环境里确实注入了代理时才解析（无代理 = 直连，无解析对象）；
 * 优先级沿用 `resolveEffectiveProxy`（HTTP_PROXY > HTTPS_PROXY）。
 * 解析依赖可注入，便于测试不依赖真实容器与 DNS。
 */
export async function resolveEffectiveProxyResolution(
  env: NodeJS.ProcessEnv,
  deps: ResolveProxyDeps = {},
): Promise<ProxyResolution | undefined> {
  const effective = resolveEffectiveProxy(env);
  if (effective.value === undefined) return undefined;
  return resolveProxyUrl(effective.value, deps);
}

/** `/codex-safe proxy` 的状态提示：区分「配置文件值」与「当前进程生效值」 */
export function describeProxyStatus(input: {
  configured: string | undefined;
  desired: string;
  effective: { value?: string; source: string };
  /** 当前进程生效代理的容器解析结果（可选；由诊断闭包异步解析后传入） */
  effectiveResolution?: ProxyResolution;
}): string {
  const { configured, desired, effective, effectiveResolution } = input;
  const lines: string[] = [];
  lines.push(`配置文件 httpProxy：${configured ?? "未设置"}`);
  lines.push(`期望代理（codex-safe.json）：${desired}`);
  if (effective.value === undefined) {
    lines.push("当前进程生效值：无（既无 settings.json 注入，也无 shell 环境变量）");
  } else {
    lines.push(`当前进程生效值：${effective.value}（来自 ${effective.source}）`);
  }
  if (configured !== undefined && configured === effective.value) {
    lines.push("配置值与进程生效值一致");
  } else if (configured !== undefined && effective.value !== undefined) {
    lines.push(
      `配置值与进程生效值不一致 —— ${effective.source} 已在环境里导出，pi 的 \`??=\` 语义会让 shell 变量优先`,
    );
  } else if (configured !== undefined) {
    lines.push("配置已写入但尚未生效：httpProxy 只在 pi 启动时注入，需重启 pi");
  }
  if (effectiveResolution) {
    lines.push("当前进程生效代理线路解析：");
    lines.push(...indentBlock(formatProxyResolution(effectiveResolution)));
  }
  return lines.join("\n");
}

export type GateAction = "continue" | "handled";

export interface GateDeps {
  enabled: boolean;
  isCodexModel: boolean;
  /** TUI / RPC 为 true；json / print 为 false（“非交互环境”的唯一判据）。 */
  hasUI: boolean;
  source: string;
  isIdle: boolean;
  text: string;
  noUiPolicy: "warn" | "block";
  check: () => Promise<GuardResult>;
  /**
   * 返回 "continue"（仅本次豁免）| "abort"（中止，含 Esc）| undefined（Esc，按中止处理）。
   * 「查看诊断」在实现内部循环，不对外返回，故不在联合类型中。
   */
  confirm: (result: GuardResult) => Promise<"continue" | "abort" | undefined>;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  now: () => number;
}

/**
 * input 闸门（纯逻辑，可测）。
 *
 * 门槛条件与理由：
 * - 非 codex 模型 / 闸门关闭 → 不管。
 * - 斜杠命令 → 放行（否则 `/codex-safe` 自己会被拦）。
 * - source=extension → 放行（扩展在已批准的轮内注入的消息不重复拦截）。
 * - 非空闲 → 放行（轮内续写由周期复检 + abort 兜底，规格 §9.1 的已知残余窗口）。
 * - 有 UI（TUI / RPC）→ **必须二次确认，绝不自动放行**；Esc 按「中止」处理。
 * - 无 UI（json / print）→ 按 noUiPolicy。
 * - 探针抛错 → 合成 UNKNOWN 后走与正常非 SAFE **完全相同**的分支，绝不静默放行。
 */
export async function handleInputGate(deps: GateDeps): Promise<{ action: GateAction }> {
  if (!deps.enabled) return { action: "continue" };
  if (!deps.isCodexModel) return { action: "continue" };
  if (deps.text.trimStart().startsWith("/")) return { action: "continue" };
  if (deps.source === "extension") return { action: "continue" };
  if (!deps.isIdle) return { action: "continue" };

  let result: GuardResult;
  try {
    result = await deps.check();
  } catch (e) {
    // R1：抛错等价于 UNKNOWN（= 非 SAFE）。合成一个 GuardResult 后复用下方同一套
    // hasUI / noUiPolicy 分支，不另写一套放行路径，不给静默放行留口子。
    result = {
      verdict: "UNKNOWN",
      domains: [
        {
          host: "探针异常",
          verdict: "UNKNOWN",
          reason: `探针异常：${e instanceof Error ? e.message : String(e)}`,
          notes: [],
        },
      ],
      checkedAt: deps.now(),
      fromCache: false,
    };
  }

  if (result.verdict === "SAFE") return { action: "continue" };

  if (deps.hasUI) {
    const choice = await deps.confirm(result);
    return { action: choice === "continue" ? "continue" : "handled" };
  }

  deps.notify(formatDoctorReport(result.domains, result.verdict), "error");
  return { action: deps.noUiPolicy === "block" ? "handled" : "continue" };
}

/** 周期复检所需的运行时依赖（把易抛错的分支集中起来，便于单测）。 */
export interface PeriodicRecheckDeps {
  enabled: boolean;
  isCodexModel: boolean;
  /** 本轮被用户显式豁免（input 闸门选「仅本次」）时不 abort，但状态行仍警示 */
  ignoreTurn: () => boolean;
  isIdle: () => boolean;
  check: () => Promise<GuardResult>;
  setStatus: (text: string | undefined) => void;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  abort: () => void;
}

/**
 * 周期复检的一拍：转差则警示 + 中止当前轮；顺带维护状态行。
 *
 * 整体 try/catch：定时器回调无人 await，`check`/`setStatus`/`notify`/`abort`
 * 任一抛出都会变成未处理的 Promise rejection 并让复检静默死掉。兜底通知后
 * 吞掉异常，保证下一次 tick 仍会执行。
 */
export async function periodicRecheck(deps: PeriodicRecheckDeps): Promise<void> {
  try {
    if (!deps.enabled) return;
    if (!deps.isCodexModel) {
      deps.setStatus(undefined);
      return;
    }
    const r = await deps.check();
    if (r.verdict === "SAFE") {
      deps.setStatus(undefined);
      return;
    }
    deps.setStatus(`⚠ codex-safe: ${verdictLabel(r.verdict)}`);
    if (!deps.ignoreTurn() && !deps.isIdle()) {
      deps.notify(`${verdictLabel(r.verdict)} —— 已中止当前轮`, "error");
      deps.abort();
    }
  } catch (e) {
    deps.notify(`codex-safe 周期复检异常：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  // 会话级状态：每次进入会话（startup/new/resume/fork/reload）都会跑本工厂
  const state = {
    cfg: { ...DEFAULT_CONFIG } as CodexSafeConfig,
    warnings: [] as string[],
    ignoreTurn: false,
    timer: undefined as ReturnType<typeof setInterval> | undefined,
  };

  const guard = createGuard({
    now: () => Date.now(),
    probeDomain: (host) => probeDomain(host, { timeoutMs: state.cfg.probeTimeoutMs }),
  });

  function isCodex(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === CODEX_PROVIDER_ID;
  }

  async function checkNow(force: boolean): Promise<GuardResult> {
    return guard.check({
      hosts: state.cfg.sentinels,
      allowedRegions: state.cfg.allowedRegions,
      ttlMs: state.cfg.cacheTtlMs,
      force,
    });
  }

  function stopTimer(): void {
    if (state.timer !== undefined) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  }

  /** 周期复检：转差则警示 + 中止当前轮；顺带维护状态行 */
  function startTimer(ctx: ExtensionContext): void {
    stopTimer();
    state.timer = setInterval(() => {
      // periodicRecheck 自身吞掉全部异常（含 ctx.abort 过期句柄等），此处无需再 await/catch。
      void periodicRecheck({
        enabled: state.cfg.enabled,
        isCodexModel: isCodex(ctx),
        ignoreTurn: () => state.ignoreTurn,
        isIdle: () => ctx.isIdle(),
        check: () => checkNow(false),
        setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text),
        notify: (m, l) => ctx.ui.notify(m, l),
        abort: () => ctx.abort(),
      });
    }, state.cfg.cacheTtlMs);
    state.timer.unref?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfig(agentDir());
    state.cfg = loaded.config;
    state.warnings = loaded.warnings;
    for (const w of loaded.warnings) ctx.ui.notify(`codex-safe 配置：${w}`, "warning");
    if (!state.cfg.enabled) return;
    if (!isCodex(ctx)) return;
    ctx.ui.notify(
      `codex-safe 已启用（哨兵 ${state.cfg.sentinels.length} 个，复检 ${state.cfg.cacheTtlMs / 1000}s）`,
      "info",
    );
    startTimer(ctx);
    // 启动预探一次（规格 §4.1）：避免首次输入才发现线路不安全，把问题提前到会话开始。
    const r = await checkNow(true);
    if (r.verdict !== "SAFE") {
      ctx.ui.notify(`codex-safe：${verdictLabel(r.verdict)}\n${formatDoctorReport(r.domains, r.verdict)}`, "error");
    }
  });

  /** 切换/恢复模型：配置的哨兵与地区可能已变，强制重探一次并重启周期复检 */
  pi.on("model_select", async (event, ctx) => {
    guard.invalidate();
    if (!state.cfg.enabled || event.model.provider !== CODEX_PROVIDER_ID) {
      stopTimer();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    startTimer(ctx);
    const r = await checkNow(true);
    if (r.verdict !== "SAFE") {
      ctx.ui.notify(`codex-safe：${verdictLabel(r.verdict)}\n${formatDoctorReport(r.domains, r.verdict)}`, "error");
    }
  });

  pi.on("agent_settled", () => {
    state.ignoreTurn = false;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  /**
   * input 硬闸：新用户回合在发出前先探针；非 SAFE 必走二次确认 / noUiPolicy，
   * 绝不自动放行。三选一的「① 继续」只豁免本轮（agent_settled 清除）。
   */
  pi.on("input", async (event, ctx) => {
    // 仅在新回合（空闲态）清除上一轮的「仅本次」豁免：轮内 steer 输入不应提前解除豁免，
    // 否则周期复检又会中止本轮。agent_settled 仍是本轮结束时的权威清除点。
    if (state.ignoreTurn && ctx.isIdle()) state.ignoreTurn = false;
    const r = await handleInputGate({
      enabled: state.cfg.enabled,
      isCodexModel: isCodex(ctx),
      hasUI: ctx.hasUI,
      source: event.source,
      isIdle: ctx.isIdle(),
      text: event.text,
      noUiPolicy: state.cfg.noUiPolicy,
      now: () => Date.now(),
      check: () => checkNow(false),
      notify: (m, l) => ctx.ui.notify(m, l),
      confirm: async function ask(result: GuardResult) {
        const choice = await ctx.ui.select(
          `codex-safe 拦下本条输入：${verdictLabel(result.verdict)}\n${formatDoctorReport(result.domains, result.verdict)}`,
          ["① 继续（我知道风险，仅本次）", "② 中止本轮（推荐）", "③ 查看诊断"],
        );
        if (choice === undefined) return "abort"; // Esc = 安全默认 = 中止
        if (choice.startsWith("①")) {
          state.ignoreTurn = true;
          return "continue";
        }
        if (choice.startsWith("③")) {
          await runDoctor(ctx);
          return ask(result);
        }
        return "abort";
      },
    });
    return r.action === "handled" ? { action: "handled" } : undefined;
  });

  pi.registerCommand("codex-safe", {
    description: "Codex 出口守卫：诊断线路是否走了代理且落地在受支持地区",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub === "doctor" || sub === "") {
        await runDoctor(ctx);
        return;
      }
      if (sub === "on" || sub === "off") {
        state.cfg = { ...state.cfg, enabled: sub === "on" };
        saveConfig(agentDir(), state.cfg);
        ctx.ui.notify(`codex-safe 已${sub === "on" ? "启用" : "关闭"}`, "info");
        return;
      }
      if (sub === "proxy") {
        await runProxy(args.trim().slice("proxy".length).trim(), ctx);
        return;
      }
      ctx.ui.notify(`未知子命令 /codex-safe ${sub}（支持 doctor / proxy / on / off）`, "warning");
    },
  });

  async function runDoctor(ctx: ExtensionContext): Promise<void> {
    // 并行探测（与 guard 同一实现）：总耗时 ≈ 最慢单域名，且单域名失败只判 UNKNOWN。
    const domains = await probeHosts(
      state.cfg.sentinels,
      (host) => probeDomain(host, { timeoutMs: state.cfg.probeTimeoutMs }),
      state.cfg.allowedRegions,
    );
    const overall = aggregateVerdict(domains);
    const proxyResolution = await resolveEffectiveProxyResolution(process.env);
    const report = formatDoctorReport(domains, overall, proxyResolution);
    ctx.ui.notify(report, overall === "SAFE" ? "info" : "error");
  }

  const settingsFile = path.join(agentDir(), "settings.json");

  async function runProxy(rest: string, ctx: ExtensionCommandContext): Promise<void> {
    const [action, ...tail] = rest.split(/\s+/).filter(Boolean);
    if (!action) {
      ctx.ui.notify(
        describeProxyStatus({
          configured: readHttpProxy(settingsFile),
          desired: state.cfg.proxyUrl,
          effective: resolveEffectiveProxy(process.env),
          effectiveResolution: await resolveEffectiveProxyResolution(process.env),
        }),
        "info",
      );
      return;
    }
    if (action === "set") {
      const url = tail[0] ?? "";
      if (!isValidProxyUrl(url)) {
        ctx.ui.notify(`代理地址需为 http:// 或 https:// 且含主机名，收到「${url}」`, "error");
        return;
      }
      try {
        const r = setHttpProxy(settingsFile, url);
        state.cfg = { ...state.cfg, proxyUrl: url.trim() };
        saveConfig(agentDir(), state.cfg);
        ctx.ui.notify(
          r.changed
            ? `已写入 httpProxy=${url.trim()}${r.backupPath ? `（备份：${r.backupPath}）` : ""}\n**必须重启 pi 才生效**（httpProxy 只在启动时注入 process.env）`
            : `httpProxy 已是 ${url.trim()}，未改动`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`写入失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
      return;
    }
    if (action === "clear") {
      try {
        const r = clearHttpProxy(settingsFile);
        ctx.ui.notify(r.changed ? "已清除 httpProxy，需重启 pi 生效" : "本来就没有 httpProxy，未改动", "info");
      } catch (e) {
        ctx.ui.notify(`清除失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
      return;
    }
    if (action === "test") {
      await runDoctor(ctx);
      return;
    }
    ctx.ui.notify(`未知子命令 /codex-safe proxy ${action}（支持 set <url> / clear / test）`, "warning");
  }
}
