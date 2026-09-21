/**
 * cost-radar 扩展入口（extensions/cost-radar/index.ts）
 *
 * 本文件只做「事件接线 + 状态行渲染 + 心跳 + /cost 命令」；/cost 五页面板整体在
 * panel.ts（showPanel + 面板纯辅助），经 PanelDeps 注入本文件闭包能力后由 index
 * 调用（层依赖严格单向：index → panel → core/config/adapters；panel 不 import index——
 * 共享契约 RadarState/PanelViewData 由 panel 导出、index 侧 type-import）。
 * 全部计价/账本/预估纯逻辑在 core.ts / adapters/*。
 *
 * 事件生命周期（依据 pi extensions.md 与 @earendil-works/pi-coding-agent 0.85.1
 * 实测 .d.ts）：
 * - 每次进入会话（startup/new/resume/fork/reload）都会跑本 default 工厂 → 本闭包
 *   状态天然是「会话级」；session_shutdown 负责清理心跳与状态行。
 * - 扩展事件 message_end 先于 sessionManager 落盘触发（agent-session.js：
 *   _emitExtensionEvent → appendMessage）。该点不重复自扫：顶部以「已落盘 entries +
 *   本轮 pending 行」单次现算账本，refresh 与看门狗共用同份结果（任务 10 优化 🟡2：
 *   金额口径一致、无双扫）；其余事件（turn_end/空闲心跳/agent_settled 等）仍按已
 *   落盘 entries 全量自扫收敛。streaming 中数字仍冻结于上一轮完成值（设计 §7：消息
 *   轮间不闪烁，回合结束立即精确）。
 * - status key "cost-radar" 与其他扩展按 key 排序后空格 join 共享第 3 行、超宽截断
 *   （PITFALLS ④）→ 状态行文本禁换行，≤45 由 core.assembleStatusLine 兜底。
 */

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  aggregateLedger,
  assembleStatusLine,
  budgetState,
  cacheState,
  deriveNextTurn,
  fmtClock,
  hitRateOf,
  parseYuanAmount,
  suggestNewSession,
} from "./core";
import type { CacheStateOut, LedgerRow, SpendResult, UsageTotals } from "./core";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config";
import type { CostRadarConfig } from "./config";
import { buildRegistry, listRows } from "./adapters/registry";
import type { Registry } from "./adapters/registry";
import { makeCostFns } from "./pricing";
import { crossCwdCount, missingProviderCount, subagentRows } from "./rows";
import { createBudget, discoverBudget, installBudget, uninstallBudget } from "./budget";
import type { Forecast, ModelAdapter, UsageLike } from "./adapters/types";
import { normalizeModelId } from "./adapters/types";
import { fmtAmt, showPanel } from "./panel";
import type { PanelDeps, PanelViewData, RadarState } from "./panel";

/** 状态行 status key（多扩展共享第 3 行，按 key 排序） */
const STATUS_KEY = "cost-radar";

/** input 闸门三选一选项（ctx.ui.select 逐字返回；Esc 取消 = undefined） */
const GATE_RAISE = "① 提高本会话预算…";
const GATE_IGNORE = "② 仅本次忽略，继续发送";
const GATE_PAUSE = "③ 暂停并丢弃本条输入";

/** 空闲心跳周期：驱动 ⚡ 倒计时 / 🧊 过期翻转 / 🌙 谷时窗翻转（设计 §5） */
const HEARTBEAT_MS = 30_000;

/** 输出均值样本窗：近 N 轮 assistant output（设计 §4.2） */
const OUTS_KEEP = 3;

/** 配置基目录：PI_CODING_AGENT_DIR 可覆盖（默认 ~/.pi/agent，config.ts 只接收 baseDir） */
function defaultCfgDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

const CFG_DIR = defaultCfgDir();

// ── 事件侧账本/状态行纯辅助（无 pi 依赖，便于走查）──────────────────────

/** pi-ai Usage → core 记账四维（多余字段如 reasoning/cost 不进账本） */
function toTotals(u: UsageLike): UsageTotals {
  return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
}

/** 文本内容粗估字符数（用户消息 content：string 或 (Text|Image)Content[]，只计 text 段） */
function textCharsOf(content: string | readonly { type: string; text?: string }[]): number {
  if (typeof content === "string") return content.length;
  let n = 0;
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") n += part.text.length;
  }
  return n;
}

/**
 * 会话 entries → 账本行（口径见设计 §3.5 / 计划任务 8「entriesToRows」）。
 * 返回 missingProvider：本 entries 快照中「有正用量但缺 provider」的 result 条数
 * （旧版 pi-subagent 检测，result 粒度）；crossCwd：本快照中 cwd !== parentCwd
 * 的子代理 result 条数——派生值（每次现算），调用方赋值而非累加。
 */
function entriesToRows(
  entries: readonly SessionEntry[],
  parentCwd: string,
): { rows: LedgerRow[]; missingProvider: number; crossCwd: number } {
  const rows: LedgerRow[] = [];
  let missingProvider = 0;
  let crossCwd = 0;
  for (const e of entries) {
    // 时间戳防御：损坏/旧版数据 Date.parse 返回 NaN 会污染排序与回合比较 → 跳过该行
    const tsRaw = e.timestamp as unknown;
    const tsMs = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw));
    if (!Number.isFinite(tsMs)) continue;
    if (e.type === "message") {
      const msg = e.message;
      if (msg.role === "assistant" && msg.usage) {
        // 实测 pi-ai AssistantMessage 字段为 provider/model（非计划猜测的 id）；
        // modelKey 用归一化 model 保证跨版本稳定（normalizeModelId 幂等）。
        rows.push({
          modelKey: `${msg.provider}/${normalizeModelId(msg.model)}`,
          usage: toTotals(msg.usage),
          tsMs,
        });
      } else if (msg.role === "toolResult" && msg.usage) {
        // 实测 pi 消息 role 为 "toolResult"（非计划文本的 "tool"）；ToolResultMessage
        // 无 provider/model 字段 → 工具执行 token 无归属，只计 rawTokens 不计金额。
        // 真机验收 A1：若渠道侧工具消息带 provider/model，此处再按该 key 归账。
        rows.push({ modelKey: null, usage: toTotals(msg.usage), tsMs });
      }
      // 子代理归账（独立分支；既有 toolResult && usage 分支为死代码，保持不动，避免影响既有行为）
      if (msg.role === "toolResult" && msg.toolName === "subagent") {
        const extra = subagentRows(msg, tsMs);
        if (extra.length > 0) rows.push(...extra);
        // 逐条计「有正用量但缺 provider」（result 粒度；提示见 message_end / 账本页）
        missingProvider += missingProviderCount(msg);
        // 逐条计「跨 cwd 未纳入共享闸门」（提示见账本页）
        crossCwd += crossCwdCount(msg, parentCwd);
      }
    } else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
      // compact 不重置账本（设计 §8）：摘要生成 usage 挂在 entry 上、无 model → null
      rows.push({ modelKey: null, usage: toTotals(e.usage), tsMs });
    }
  }
  return { rows, missingProvider, crossCwd };
}

/** 最新 assistant 轮（按时间升序取最后一条 usage）及近 ≤3 轮输出（账本侧权威快照） */
interface RoundInfo {
  usage: UsageTotals;
  atMs: number;
  outs: number[];
}

function ledgerRound(rows: LedgerRow[]): RoundInfo | null {
  const assistant = rows
    .filter((r) => r.modelKey !== null)
    .sort((a, b) => a.tsMs - b.tsMs);
  if (assistant.length === 0) return null;
  const last = assistant[assistant.length - 1];
  return {
    usage: last.usage,
    atMs: last.tsMs,
    outs: assistant.slice(-OUTS_KEEP).map((r) => r.usage.output),
  };
}

/** 三档预估文案（金额紧凑格式）。当前模型无缓存语义或 hot===cold → 合并为 续X/新Z（设计 §7） */
function tiersText(f: { hot: number; cold: number; fresh: number }, cacheable: boolean): string {
  const merged = !cacheable || f.hot === f.cold;
  const m = fmtAmt;
  return merged ? `续${m(f.hot)}/新${m(f.fresh)}` : `续${m(f.hot)}/冷${m(f.cold)}/新${m(f.fresh)}`;
}

/** 缓存段（设计 §5/§7）：warm→⚡倒计时、expired→🧊、rebuilding→♻️、unknown→不占段 */
function cacheText(phase: CacheStateOut): string | null {
  switch (phase.phase) {
    case "warm":
      return `⚡${fmtClock(phase.secondsLeft ?? 0)}`;
    case "expired":
      return "🧊";
    case "rebuilding":
      return "♻️";
    default:
      return null;
  }
}

export default function (pi: ExtensionAPI) {
  /**
   * 本次工厂实例的唯一标识（每个 /reload 产生新实例）。
   * 既用于总线发布的实时闭包绑定，也作为 uninstall 的归属凭据。
   */
  const instanceId = randomUUID();
  const state: RadarState = {
    cfg: { ...DEFAULT_CONFIG, priceOverrides: {}, userPresets: {} },
    sessionModel: null,
    lastUsage: null,
    lastUsageAtMs: 0,
    outs: [],
    sessionBudget: null,
    paused: false,
    ignoreTurn: false,
    gateFiredThisTurn: false,
    hidden: false,
    heartbeat: null,
    commandConflict: false,
  };
  /** 最近一次事件携带的会话 ctx（供心跳在空闲时刷新状态行） */
  let sessionCtx: ExtensionContext | null = null;
  /** 父会话已落盘 spend 快照（供闸门 check() 读取） */
  let lastSpendYuan = 0;
  /** 本次会话「有正用量但缺 provider」的 result 条数（派生，每次现算） */
  let subagentMissingProvider = 0;
  /** 本次会话「跨 cwd 未纳入共享闸门」的子代理 result 条数（派生，每次现算） */
  let subagentCrossCwd = 0;
  /** 「缺 provider」升级提示是否已发（每会话一次） */
  let subagentUnaccountedNotified = false;

  /** 停心跳（session_shutdown） */
  function stopHeartbeat(): void {
    if (state.heartbeat !== null) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
  }

  /** 状态行显示开关（/cost off|on 与面板设置页共用） */
  function switchStatus(on: boolean, ctx: ExtensionContext): void {
    state.hidden = !on;
    if (on) {
      refresh(ctx);
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  /**
   * 账本单次现算产物：getEntries → entriesToRows → registry → aggregateLedger 一步成型。
   * extraRow 供 message_end 并入「本轮尚未落盘」的 assistant 行（任务 10 优化 🟡2：
   * refresh 与看门狗共用同一次现算 → 金额口径一致，免双扫 O(entries) 与 registry 重建）。
   */
  interface LedgerScan {
    entries: readonly SessionEntry[];
    rows: LedgerRow[];
    reg: Registry;
    ledger: SpendResult;
  }

  function scanLedger(ctx: ExtensionContext, extraRow?: LedgerRow): LedgerScan {
    const entries = ctx.sessionManager.getEntries();
    const { rows, missingProvider, crossCwd } = entriesToRows(entries, ctx.cwd);
    if (extraRow) rows.push(extraRow);
    const reg = buildRegistry(state.cfg.usdRate, state.cfg.priceOverrides);
    const { coveredOf, costOf } = makeCostFns(reg);
    // 派生赋值（非累加）：每次重扫全部 entries，重复累加会失真
    subagentMissingProvider = missingProvider;
    subagentCrossCwd = crossCwd;
    const ledger = aggregateLedger(rows, costOf, coveredOf);
    lastSpendYuan = ledger.spendYuan; // 供闸门 check() 读取的父 spend 快照
    return { entries, rows, reg, ledger };
  }

  /**
   * 单次现算会话视图数据。状态行 refresh 与面板各页共用本函数 → 天然同源
   * （覆盖价/汇率/本会话预算改动后重算即生效）。非 TUI/隐藏时无需调用（调用方守卫）。
   * scan 传入时（message_end）复用其中已含本轮 pending 的 entries/rows/reg/ledger；
   * 不传则自身全量自扫（turn_end/心跳/面板等调用点口径不变，见各调用处）。
   */
  function buildPanelData(ctx: ExtensionContext, scan?: LedgerScan): PanelViewData {
    const s = scan ?? scanLedger(ctx);
    const { entries, rows, reg, ledger } = s;
    const rawTotal = ledger.rawTokens.input + ledger.rawTokens.output + ledger.rawTokens.cacheRead + ledger.rawTokens.cacheWrite;
    const hasUsage = rows.length > 0 && rawTotal > 0;

    // 当前生效模型：model_select/session_start 快照优先，兜底最近 assistant 行的归属
    let model = state.sessionModel;
    if (!model && ctx.model) model = { provider: ctx.model.provider, id: ctx.model.id };
    if (!model) {
      const last = rows
        .filter((r) => r.modelKey !== null)
        .sort((a, b) => b.tsMs - a.tsMs)[0];
      if (last?.modelKey) {
        const i = last.modelKey.indexOf("/");
        if (i > 0) model = { provider: last.modelKey.slice(0, i), id: last.modelKey.slice(i + 1) };
      }
    }
    const adapter = model ? reg.lookup(model.provider, model.id) : null;
    const covered = adapter !== null;

    // 最近一轮 usage（账本最新已落盘轮 vs 事件快照，取更新者；resume 时事件侧为空 → 走账本）
    const round = ledgerRound(rows);
    let usage: UsageTotals | null = null;
    let outs: number[] = [];
    let usageAtMs = 0;
    if (round && round.atMs >= state.lastUsageAtMs) {
      usage = round.usage;
      outs = round.outs;
      usageAtMs = round.atMs;
    } else if (state.lastUsage !== null) {
      usage = state.lastUsage;
      outs = state.outs;
      usageAtMs = state.lastUsageAtMs;
    }

    const nowMs = Date.now();
    const a = adapter as ModelAdapter | null;
    const ctxPct = ctx.getContextUsage()?.percent ?? 0;

    // 缓存相位：仅缓存语义模型 + 有最近一轮 usage
    let cache: CacheStateOut | null = null;
    if (covered && a && a.cacheable && usage !== null) {
      cache = cacheState({
        lastInput: usage.input,
        lastCacheRead: usage.cacheRead,
        lastCacheWrite: usage.cacheWrite,
        lastActivityMs: usageAtMs,
        nowMs,
      });
    }

    // 三档预估 / 💡 建议：仅收录且有 usage（suggestNewSession 契约参数序 (ctx,fresh,cold)）
    let forecast: Forecast | null = null;
    let tiers: string | null = null;
    let suggest: { show: boolean; savePerRoundYuan: number } | null = null;
    if (covered && a && usage !== null) {
      const next = deriveNextTurn({
        lastPromptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outs,
        systemChars: ctx.getSystemPrompt().length,
        lastUserChars: lastUserCharsOf(entries),
      });
      // 无历史时的 hitRate 回退取 1（全局契约：三档预估公式）
      const hit = usage.input + usage.cacheRead + usage.cacheWrite === 0 ? 1 : hitRateOf(usage);
      forecast = a.forecast({ q: next.q, out: next.out, sys: next.sys, hitRate: hit }, nowMs);
      tiers = tiersText(forecast, a.cacheable);
      suggest = suggestNewSession(ctxPct, forecast.fresh, forecast.cold);
    }

    // 谷时徽标（计价器声明谷时且此刻命中）
    let valley = false;
    if (covered && a && a.hasValley && typeof a.inValley === "function") {
      valley = a.inValley(nowMs);
    }

    return {
      hasUsage,
      ledger,
      covered,
      adapter: a,
      model,
      usage,
      outs,
      usageAtMs,
      nowMs,
      cacheable: covered && !!a?.cacheable,
      cache,
      valley,
      tiers,
      forecast,
      suggest,
      ctxPct,
      subagentMissingProvider,
      subagentCrossCwd,
      budget: budgetState({
        defaultBudget: state.cfg.defaultBudget,
        sessionBudget: state.sessionBudget,
        spendYuan: ledger.spendYuan,
      }),
    };
  }

  /** 预算段：生效额度已设才展示（defaultBudget / 本会话预算，core.budgetState 契约） */
  function pushBudgetPart(parts: string[], d: PanelViewData): void {
    if (d.budget.enabled) parts.push(`预算${d.budget.pct}%`);
  }

  /** 状态行出街：暂停前缀 ⏸；assembleStatusLine 自尾丢段保 ≤45；空文本清行 */
  function setLine(ctx: ExtensionContext, parts: string[]): void {
    const line = assembleStatusLine(parts);
    if (line === "") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, state.paused ? `⏸ ${line}` : line);
  }

  /** 最近一条用户消息文本字符数（fresh 预估的 U 分量，设计 §4.1） */
  function lastUserCharsOf(entries: readonly SessionEntry[]): number {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "message" && e.message.role === "user") {
        return textCharsOf(e.message.content);
      }
    }
    return 0;
  }

  /**
   * 单次重算并 setStatus（非 TUI 直接返回，设计 §9：非 TUI 跳过状态行）。
   * 数据源：sessionManager.getEntries() 现算账本（消耗永不持久化，设计 §8），
   * 会话级快照 state（lastUsage/outs）仅用于覆盖 message_end 先于落盘的空窗。
   * scan 可选：message_end 传入含本轮 pending 的单次现算产物（与看门狗同源，金额
   * 含刚完成本轮）；其余调用点（turn_end/heartbeat/agent_settled/model_select/事件）
   * 不传 → 按已落盘 entries 全量自扫，保持各自既有口径。
   */
  function refresh(ctx: ExtensionContext, scan?: LedgerScan): void {
    if (ctx.mode !== "tui" || state.hidden) return;
    const d = buildPanelData(ctx, scan);
    const parts: string[] = [];

    // 无任何 usage 历史（新会话/刚 compact）：整行仅 ⛽暂无数据（设计 §7/§11）
    if (!d.hasUsage) {
      setLine(ctx, ["⛽暂无数据"]);
      return;
    }

    // ① ⛽ 累计（设计 §7）：当前模型未收录 → ⛽未收录 + 三档占位「-」；收录 → ¥ 金额
    parts.push(d.covered ? `⛽¥${fmtAmt(d.ledger.spendYuan)}` : "⛽未收录");
    if (!d.covered) {
      // 未收录模型：金额与预估均不可得（token 仍计入 rawTokens 口径，面板展示）
      parts.push("续-/冷-/新-");
      pushBudgetPart(parts, d);
      setLine(ctx, parts);
      return;
    }

    // ② 🌙 谷时徽标（缓存段前追加，设计 §7）
    if (d.valley) parts.push("🌙谷");

    // ③ 缓存段：仅缓存语义模型 + 有最近一轮 usage
    if (d.cacheable && d.cache && d.usage !== null) {
      const t = cacheText(d.cache);
      if (t) parts.push(t);
    }

    // ④ 三档预估 + 💡 徽标
    let bulb: string | null = null;
    if (d.usage !== null && d.tiers !== null) {
      parts.push(d.tiers);
      if (d.suggest?.show) {
        const save = d.suggest.savePerRoundYuan;
        bulb = save > 0 ? `💡新会话省¥${fmtAmt(save)}/轮` : "💡建议新会话";
      }
    }

    // ⑤ 预算进度（未启用不显示）；段序 = [spend, 谷, 缓存, tiers, 预算, 💡]：
    // 超 45 自尾丢段时先丢 💡 再丢 预算（core.assembleStatusLine 契约）
    pushBudgetPart(parts, d);
    if (bulb !== null) parts.push(bulb);

    setLine(ctx, parts);
  }

  // ── 预算闸门 / 看门狗 / 暂停（任务 10，设计 §6）────────────────

  /** 生效额度：本会话预算优先，其次默认预算；两者皆未设 → null（闸门关闭，需用户显式清除默认后且未设会话预算才出现） */
  function effectiveLimit(): number | null {
    return state.sessionBudget ?? state.cfg.defaultBudget;
  }

  /**
   * 当前账本已用金额（¥）。口径与 refresh 一致 = 对已落盘 entries 现算的
   * aggregateLedger().spendYuan（core 契约：已收录且可计模型合计）。
   * 仅 input 闸门三选一使用（判定时机在用户输入时，entries 已完整）；message_end
   * 看门狗不再经本函数现算——顶部单次 scanLedger 已含本轮 pending（见 runWatchdog）。
   */
  function ledgerSpend(ctx: ExtensionContext): number {
    return scanLedger(ctx).ledger.spendYuan;
  }

  /**
   * ¥ 金额解析（/cost budget CLI 与闸门①（提高本会话预算）共用，任务 10 优化 🟡3）：首尾空白与
   * ¥/￥/元/千分逗号剥离后，主体交 core.parseYuanAmount 严格校验——仅普通十进制小数且
   * >0（拒绝 0/负/NaN/hex/指数/科学计数/内部与尾随空白；旧 Number() 路径会把 "0x10"=16、
   * "1e5"=100000 误收）。面板预算 GUI 自己的 min 0.01 下限由 panel number 控件保留，
   * 其读取处与 CLI/本会话预算共用本函数同一语义（仅格式层校验，不叠加 0.01 下限）。
   */
  function parseBudgetAmount(raw: string): number | null {
    return parseYuanAmount(raw.trim().replace(/[¥￥元,]/g, ""));
  }

  /** 配置落盘统一入口（CLI 用）：失败 notify 一次不抛（设计 §11：写入失败不崩溃） */
  function persistCostConfig(ctx: ExtensionContext): boolean {
    try {
      saveConfig(CFG_DIR, state.cfg);
      return true;
    } catch (err) {
      ctx.ui.notify(`cost-radar 配置写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
      return false;
    }
  }

  /** 预算暂停（闸门③ / 对话框取消 / 本会话预算无效的保守路径，设计 §6.2）：置 paused，后续交互输入被吞直至新会话 */
  function pauseForBudget(ctx: ExtensionContext, spendYuan: number, limitYuan: number): void {
    state.paused = true;
    ctx.ui.notify(
      `cost-radar 已暂停：本回合不发送。超支 ¥${fmtAmt(spendYuan)} ≥ ¥${fmtAmt(limitYuan)}；输入 /new 开新会话恢复`,
      "warning",
    );
    if (ctx.mode === "tui" && !state.hidden) {
      // 🟡1 简化：本行细节（已暂停/金额）为瞬时提示，随后 refresh 会用 ⏸ 前缀 + 常规段
      // 覆盖成稳态行（paused 已置位 → ⏸ 语义不丢）；一次性事件详情以 notify 为唯一告知渠道。
      ctx.ui.setStatus(STATUS_KEY, `⏸ 预算超支，已暂停 ¥${fmtAmt(spendYuan)}/¥${fmtAmt(limitYuan)}`);
    }
  }

  /**
   * 看门狗（设计 §6.3，message_end 内调用）：spend 取 message_end 顶部单次现算账本
   * （scanLedger 已并入本轮 pending，与 refresh 同源 → 同一份金额，任务 10 优化 🟡2），
   * ≥ 生效额度、未被 ignoreTurn 豁免、同回合尚未中止过 → ctx.abort()（中止当前轮后续调用，
   * 已产出消息保留，落盘发生在扩展事件之后）。gateFiredThisTurn 由 turn_start 重置——
   * 同回合只中止/notify 一次。
   */
  function runWatchdog(ctx: ExtensionContext, ledger: SpendResult): void {
    try {
      // §9 子会话托管态：子会话（in-memory、无 UI）命中父闸门时额度交由父闸门，
      // 禁用本地看门狗避免重复中止（早于 state.paused 判定）。
      try {
        const bus = discoverBudget();
        if (bus && !ctx.hasUI && bus.ownerSessionId !== ctx.sessionManager.getSessionId()) return;
      } catch {
        // 发现失败按基线行为（保守）
      }
      if (state.paused || state.ignoreTurn || state.gateFiredThisTurn) return;
      const limit = effectiveLimit();
      if (limit === null) return; // 未设额度不干预
      const spendYuan = ledger.spendYuan;
      if (spendYuan < limit) return; // 非超支不干预
      state.gateFiredThisTurn = true;
      ctx.abort();
      ctx.ui.notify(
        `cost-radar 预算超支（¥${fmtAmt(spendYuan)} ≥ ¥${fmtAmt(limit)}），已中止本回合后续调用`,
        "warning",
      );
      if (ctx.mode === "tui" && !state.hidden) {
        // 🟡1 简化：本行是瞬时指示，会随 agent_settled/turn_end 的 refresh 被还原为普通
        // 超支稳态行——「已中止/已暂停」等一次性事件以 notify 为唯一告知渠道，状态行仅
        // 表达超支/暂停稳态（本处仍置行仅为中止瞬间给用户即刻反馈，不承载长期语义）。
        ctx.ui.setStatus(STATUS_KEY, `⏸ 预算超支，已中止 ¥${fmtAmt(spendYuan)}/¥${fmtAmt(limit)}`);
      }
    } catch {
      // 看门狗自愈：判定异常不得影响消息生命周期（runner 有兜底 catch，仍避免无谓告警）
    }
  }

  /** session_start：重载配置 + 重置会话态 + 心跳 + 首刷 */
  pi.on("session_start", (_event, ctx) => {
    let config: CostRadarConfig;
    let warnings: string[];
    try {
      ({ config, warnings } = loadConfig(CFG_DIR, listRows()));
    } catch (err) {
      // IO 异常（EACCES 等）抛自 config 层之外时兜底默认值（设计 §11：读取失败用默认+警告不崩溃）
      config = { ...DEFAULT_CONFIG };
      warnings = [`读取配置失败（${err instanceof Error ? err.message : String(err)}），已用默认配置`];
    }
    state.cfg = config;
    state.sessionModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    state.lastUsage = null;
    state.lastUsageAtMs = 0;
    state.outs = [];
    state.sessionBudget = null;
    state.paused = false;
    state.ignoreTurn = false;
    state.gateFiredThisTurn = false;
    state.hidden = false;
    lastSpendYuan = 0;
    subagentMissingProvider = 0;
    subagentCrossCwd = 0;
    subagentUnaccountedNotified = false;
    if (state.commandConflict && ctx.hasUI) {
      ctx.ui.notify("「cost」命令与既有命令冲突，状态行仍显示", "warning");
    }
    if (warnings.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`cost-radar 配置告警：${warnings.join("；")}`, "warning");
    }
    sessionCtx = ctx;
    if (ctx.mode === "tui" && state.heartbeat === null) {
      state.heartbeat = setInterval(() => {
        const c = sessionCtx;
        if (!c || state.hidden) return;
        if (c.mode !== "tui" || !c.isIdle()) return; // 工作中/排队时暂停心跳（请求连续，缓存不空闲过期）
        try {
          refresh(c);
        } catch {
          // interval 回调异常无框架兜底，本地捕获避免拖垮 pi 进程（设计 §11）
          stopHeartbeat();
          c.ui.notify("cost-radar 状态刷新异常，已停用心跳", "error");
        }
      }, HEARTBEAT_MS);
    }
    refresh(ctx);
    // 只读闸门总线发布（设计 §5，仅 TUI 父会话）：
    // - 无残留 → 安装；
    // - 残留总线属于**本会话 id** → 允许覆盖安装：/reload 正常会先发
    //   session_shutdown 清理（pi 0.85.1 agent-session.reload → emitSessionShutdownEvent
    //   reason:"reload"），但若历史实例清理失败或未来 SDK 改语义导致同会话总线残留，
    //   旧闭包的 getLimit/getParentSpend/getRegistry 仍指向被替换实例的快照；同会话覆盖
    //   使本会话始终绑定最新实例的实时快照。
    //   时序假设：正常序列为 shutdown（旧实例）→ start（新实例）。即使未来 SDK 反序
    //   （start 先于 shutdown），旧实例的 uninstall 也因 instanceId 不匹配而不会误删新
    //   bus（总线携带 instanceId，uninstall 仅清理自建总线）。
    // - 残留总线属于**其它会话 id** → 跳过（保留「同进程同 cwd 多 TUI 会话先建者拥有」语义）。
    // getParentSpend 读已落盘 spend 快照（含此前 subagent details），price 复用同一计价口径。
    try {
      const existing = discoverBudget();
      const sessionId = ctx.sessionManager.getSessionId();
      if ((!existing || existing.ownerSessionId === sessionId) && ctx.mode === "tui" && ctx.hasUI) {
        installBudget(createBudget({
          ownerSessionId: sessionId,
          instanceId,
          cwd: ctx.cwd,
          getLimit: effectiveLimit,
          getParentSpend: () => lastSpendYuan,
          getRegistry: () => buildRegistry(state.cfg.usdRate, state.cfg.priceOverrides),
        }));
      }
    } catch {
      // 闸门发布失败不影响账本/状态行
    }
  });

  /** message_end：仅 assistant 带 usage 时更新快照，并单次现算账本（含本轮 pending）供
   *  refresh 与看门狗共用（任务 10 优化 🟡2：免双扫 O(entries)、金额口径一致）；用户/工具消息不刷新 */
  pi.on("message_end", (event, ctx) => {
    sessionCtx = ctx;
    const msg = event.message;
    if (msg.role === "assistant" && msg.usage) {
      state.lastUsage = toTotals(msg.usage);
      state.lastUsageAtMs = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
      state.outs.push(msg.usage.output);
      if (state.outs.length > OUTS_KEEP) state.outs.shift();
      if (!state.sessionModel && msg.provider && msg.model) {
        state.sessionModel = { provider: msg.provider, id: msg.model };
      }
      // 顶部统一现算一次：message_end 先于本轮消息落盘（agent-session：emit 扩展事件 →
      // appendMessage），故把刚完成的本轮并入 entries 现算（口径同旧 runWatchdog pendingRow），
      // refresh 与看门狗读同一份 ledger —— 消除「refresh 不含本轮 vs 看门狗含本轮」的
      // 金额展示不一致窗口；msg 无 provider/model 时按无归属行并入（token 计、金额不计）。
      const rawTs = msg.timestamp as unknown;
      const tsMs = typeof rawTs === "number" ? rawTs : Date.parse(String(rawTs));
      const scan = scanLedger(ctx, {
        modelKey: msg.provider && msg.model ? `${msg.provider}/${normalizeModelId(msg.model)}` : null,
        usage: toTotals(msg.usage),
        tsMs: Number.isFinite(tsMs) ? (tsMs as number) : Date.now(),
      });
      refresh(ctx, scan);
      // 看门狗（任务 10）：spend（含本轮，与 refresh 同源）≥ 额度 → 中止后续轮次（见 runWatchdog）
      runWatchdog(ctx, scan.ledger);
      // 一次性提示（缺 provider/契约）：已扫描出「有正用量但不可计」且本会话未提示过
      if (
        ctx.hasUI &&
        subagentMissingProvider > 0 &&
        !subagentUnaccountedNotified
      ) {
        subagentUnaccountedNotified = true;
        ctx.ui.notify("检测到子代理用量但缺少 provider/契约标记，未计入账本（需升级 pi-subagent）", "warning");
      }
    }
  });

  /** turn_start：重置看门狗单回合中止闸（同回合只中止一次；新回合重新放行） */
  pi.on("turn_start", (_event, _ctx) => {
    state.gateFiredThisTurn = false;
  });

  /** turn_end：账本已含整轮已落盘消息 → 精确刷新（不在此清 ignoreTurn——多轮 agent 循环内
   *  turn_end 每轮都触发，过早清除会让看门狗在后续轮重新武装，违背「仅本次忽略」整轮豁免语义） */
  pi.on("turn_end", (_event, ctx) => {
    sessionCtx = ctx;
    refresh(ctx);
  });

  /** agent_settled：本轮请求（含自动重试/压缩/续问）彻底结束后清理豁免与中止闸。
   *  每次新的用户输入必先经过本事件（agent_settled 先于下一次 idle 输入触发，无泄漏）；
   *  用 agent_end 不足（auto-retry/compact 还会再起新 run，看门狗会重新武装）。 */
  pi.on("agent_settled", (_event, ctx) => {
    sessionCtx = ctx;
    state.ignoreTurn = false;
    state.gateFiredThisTurn = false;
    refresh(ctx);
  });

  /** model_select：会话模型切换 → 计价器/三档/谷时随新模型重估 */
  pi.on("model_select", (event, ctx) => {
    sessionCtx = ctx;
    state.sessionModel = { provider: event.model.provider, id: event.model.id };
    refresh(ctx);
  });

  /** session_compact：重写上下文后视为新活动（缓存计时从此刻起），账本不重置 */
  pi.on("session_compact", (_event, ctx) => {
    sessionCtx = ctx;
    state.lastUsageAtMs = Date.now();
    refresh(ctx);
  });

  /** session_shutdown：清状态行 + 停心跳 */
  pi.on("session_shutdown", (_event, ctx) => {
    stopHeartbeat();
    sessionCtx = null;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    try {
      uninstallBudget(instanceId);
    } catch {
      // 清理失败忽略
    }
  });

  /**
   * input 闸门（设计 §6.2，任务 10）：达生效额度后新用户回合被拦，三选一。
   * - 只拦 TUI 交互输入且 idle 的回合；extension/rpc source 与 streaming 中的队列输入放行（设计 §6.6）；
   * - 斜杠命令由扩展命令分发层先于 input 事件处理（逃生通道，设计 §6.5）——此处仍防御放行；
   * - 暂停（paused）吞掉输入返回 handled（含提示）；「仅本次忽略」由 agent_settled 清除（防泄漏到新输入）；
   * - ctx.ui.select/input 弹窗会把编辑器临时替换为弹窗组件（pi 交互层实现），与任务 9 面板
   *   「叠弹窗卸载 custom 组件」同源——但本闸门在 prompt() 处理链中执行、不在 custom 面板内，
   *   等价于内置 /session 等命令的确认交互，按真实 API 直接可用，无偏差。
   */
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || !ctx.isIdle()) return;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (event.text.trimStart().startsWith("/")) return; // 斜杠命令防御放行

    // ignoreTurn 只豁免「它被设置的那次输入」启动的整轮请求；agent_settled 正常情况下已在下次
    // 输入前清除。若 abort 等路径未达 agent_settled，此处兑底清除，避免豁免泄漏到新输入（新输入 = 新决策）
    if (state.ignoreTurn) state.ignoreTurn = false;

    // 暂停态：吞掉交互输入（恢复 = 新会话；session_start 重置 paused）
    if (state.paused) {
      ctx.ui.notify("cost-radar 已暂停：本条输入已丢弃；输入 /new 开新会话恢复", "warning");
      if (!state.hidden) ctx.ui.setStatus(STATUS_KEY, "⏸ 已暂停（/new 恢复）");
      return { action: "handled" };
    }

    const limit = effectiveLimit();
    if (limit === null) return; // 未设额度 → 闸门关闭（零打扰）
    let spendYuan: number;
    try {
      spendYuan = ledgerSpend(ctx);
    } catch {
      return; // 账本现算失败不拦输入（保守放行，设计 §11）
    }
    if (spendYuan < limit) return; // 未超支不干预

    // —— 三选一 ——
    const choice = await ctx.ui.select(
      `cost-radar 预算超支：已用 ¥${fmtAmt(spendYuan)} ≥ 额度 ¥${fmtAmt(limit)}，本条输入被拦`,
      [GATE_RAISE, GATE_IGNORE, GATE_PAUSE],
    );
    if (choice === GATE_IGNORE) {
      // ② 仅本次忽略：看门狗整轮豁免（agent_settled 清除），消息继续发送
      state.ignoreTurn = true;
      ctx.ui.notify("cost-radar 本轮已忽略预算拦截，消息继续发送（整轮结束自动恢复）", "info");
      return { action: "continue" };
    }
    if (choice === GATE_RAISE) {
      // ① 提高本会话预算：输入 >0 的金额写 sessionBudget（覆盖默认，可高可低）；0/非法/取消均不设（0=无效，防绕过），保守按暂停
      const raw = await ctx.ui.input(
        `本会话预算 ¥（仅本会话，覆盖默认额度 ¥${fmtAmt(limit)}；需 >0）`,
        "",
      );
      const n = raw === undefined ? null : parseBudgetAmount(raw);
      if (n === null) {
        pauseForBudget(ctx, spendYuan, limit);
        return { action: "handled" };
      }
      state.sessionBudget = n;
      refresh(ctx);
      ctx.ui.notify(`cost-radar 本会话预算已设为 ¥${fmtAmt(n)}（覆盖默认；/new 后回落默认额度）`, "info");
      return { action: "continue" };
    }
    // ③ 暂停 / 取消对话框（choice === undefined）→ 保守暂停并吞掉输入（设计 §6.2）
    pauseForBudget(ctx, spendYuan, limit);
    return { action: "handled" };
  });

  /** /cost 面板依赖（panel.ts 不 import index，能力经此注入） */
  const panelDeps: PanelDeps = {
    state,
    cfgDir: CFG_DIR,
    buildPanelData,
    refresh,
    switchStatus,
  };

  // ── /cost 命令（off/on 开关 + budget CLI（任务 10）+ 无参开五页面板（任务 9））──
  try {
    pi.registerCommand("cost", {
      description: "费用雷达：/cost budget ¥N|clear 设默认预算 · off/on 状态行开关 · 无参打开五页交互面板",
      handler: async (args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("cost-radar 需要 TUI 模式", "error");
          return;
        }
        const sub = args.trim().split(/\s+/)[0] ?? "";
        if (sub === "off") {
          switchStatus(false, ctx);
          ctx.ui.notify("cost-radar 状态行已隐藏（/cost on 恢复）", "info");
          return;
        }
        if (sub === "on") {
          switchStatus(true, ctx);
          ctx.ui.notify("cost-radar 状态行已显示", "info");
          return;
        }
        if (sub === "budget") {
          // 任务 10：/cost budget ¥N 设默认预算（存配置）/ clear 清除；面板预算页为同语义 GUI 入口
          const rest = args.slice("budget".length).trim();
          if (rest === "") {
            ctx.ui.notify("/cost budget 用法：¥N 设默认预算 / clear 清除（如 /cost budget 10）", "info");
            return;
          }
          if (rest === "clear") {
            state.cfg.defaultBudget = null;
            if (!persistCostConfig(ctx)) return;
            refresh(ctx);
            ctx.ui.notify("cost-radar 默认预算已清除（预算闸门关闭）", "info");
            return;
          }
          const n = parseBudgetAmount(rest);
          if (n === null) {
            ctx.ui.notify(`默认预算无效：“${rest}”（需 >0 金额，可带 ¥ 前缀；clear 可清除）`, "warning");
            return;
          }
          state.cfg.defaultBudget = n;
          if (!persistCostConfig(ctx)) return;
          refresh(ctx);
          ctx.ui.notify(`cost-radar 默认预算已设为 ¥${fmtAmt(n)}（超支触发拦截/看门狗）`, "info");
          return;
        }
        if (sub !== "") {
          ctx.ui.notify(`未知子命令 /cost ${sub}（当前支持 budget/off/on 与面板）`, "warning");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("cost-radar 面板需要 TUI 模式", "warning");
          return;
        }
        await showPanel(panelDeps, ctx);
      },
    });
  } catch {
    // 注册冲突（规格 §11）：捕获后静默，session_start 时一次性告警，不让扩展整体加载失败
    state.commandConflict = true;
  }
}
