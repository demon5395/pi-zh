/**
 * cost-radar /cost 交互面板（extensions/cost-radar/panel.ts）
 *
 * 任务 9 五页面板自 index.ts 抽离（任务 10 前可维护性拆分）：面板纯辅助
 * （schema 驱动录入计划/组装）+ 五页/录入/预设状态机整体收编本文件；页级状态在本
 * 文件 ui.custom 闭包内共享。与扩展外壳的交互一律经 PanelDeps 注入
 * （state / buildPanelData / refresh / switchStatus / cfgDir）——本文件完全不 import
 * index：共享契约（RadarState/PanelViewData）与 PanelDeps 一并随本文件定义导出，由
 * index 侧 type-import，层依赖严格单向：index → panel。
 *
 * 交互模型（参考 zh-hotkeys 三级状态机 + 分页模式，随任务 9 演进而定型）：
 * - 顶部 nav：←/→ 翻页（tui.editor.cursorLeft/Right 即左右键绑定），Esc 逐级返回；
 * - 正文 = 信息行 + （可选）SelectList 动作列表；列表内 Enter 执行、Esc 返回上级；
 * - 文本录入（数字/HH:MM/预设名）用面板内嵌录入态，不叠 ctx.ui.input 弹窗
 *   （叠弹窗会先把本 custom 组件移出 editorContainer，面板无法继续渲染）；
 * - 非法值一律拒绝并回显原因（设计 §11），绝不静默写入；
 * - 写回一律经 config 函数 + saveConfig（原子写）；面板读数据一律经
 *   deps.buildPanelData——与状态行 refresh 同源口径，避免两套计算分叉。
 */

import path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";
import { fmtClock, fmtTokens, fmtYuan } from "./core";
import type { BudgetStateOut, CacheStateOut, SpendResult, UsageTotals } from "./core";
import type { CostRadarConfig } from "./config";
import {
  CONFIG_FILENAME,
  applyOverrides,
  listPresets,
  removePreset,
  saveConfig,
  savePreset,
  validateOverride,
} from "./config";
import { listRows } from "./adapters/registry";
import type { Forecast, ModelAdapter, ParamSchema, ParamValue, RowSpec } from "./adapters/types";
import { mergeParamsDeep } from "./adapters/types";

// ── 会话/视图共享契约（index 组装实例与数据，panel 消费；随本文件导出供 index type-import）──

/** 会话级内存态（不持久化；设计 §8「会话态」） */
export interface RadarState {
  /** 当前配置（session_start 时从 cost-radar.json 重载） */
  cfg: CostRadarConfig;
  /** 当前会话模型（ctx.model / model_select 事件） */
  sessionModel: { provider: string; id: string } | null;
  /** 最近一次 assistant usage（事件侧快照，覆盖 message_end 早于落盘的空窗） */
  lastUsage: UsageTotals | null;
  /** 事件侧最近 assistant 完成时刻（ms） */
  lastUsageAtMs: number;
  /** 事件侧最近 ≤3 轮输出（用于 O 均值，同 lastUsage 覆盖同一空窗） */
  outs: number[];
  /** 本会话预算（¥）；覆盖默认预算，可高可低；超支三选一与面板预算页共用写入，内存态（/new 回落） */
  sessionBudget: number | null;
  /** 暂停标志（任务 10 置位；状态行整行前缀 ⏸） */
  paused: boolean;
  /** 仅本次忽略标记：input 闸门②置位，看门狗整轮豁免；agent_settled 清除（input 入口兑底），防泄漏到下次输入 */
  ignoreTurn: boolean;
  /** 看门狗中止闸：同一回合已因超支 abort 过一次；turn_start 重置（agent_settled 一并重置），防重复中止/重复 notify */
  gateFiredThisTurn: boolean;
  /** /cost off|on 显示开关 */
  hidden: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** registerCommand 冲突（与内置命令撞名，规格 §11） */
  commandConflict: boolean;
}

// ── 面板/状态行同源数据快照（buildPanelData，口径唯一实现，设计 §3.5/§7）──

export interface PanelViewData {
  /** 有账本行且 token 合计 > 0（false → 「⛽暂无数据」） */
  hasUsage: boolean;
  ledger: SpendResult;
  /** 当前生效模型是否已收录（未收录 → 金额/预估不可得） */
  covered: boolean;
  adapter: ModelAdapter | null;
  model: { provider: string; id: string } | null;
  /** 最近一轮 usage（账本侧 vs 事件快照取新者）；可能为 null */
  usage: UsageTotals | null;
  outs: number[];
  /** usage 对应活动时刻（缓存 TTL 计时起点） */
  usageAtMs: number;
  nowMs: number;
  cacheable: boolean;
  /** 缓存相位（covered && cacheable && usage 时有值） */
  cache: CacheStateOut | null;
  /** 当前是否命中谷时（covered && 计价器声明谷时） */
  valley: boolean;
  /** 三档文案（covered && usage 时有值） */
  tiers: string | null;
  forecast: Forecast | null;
  /** 💡 建议（covered && usage 时有值） */
  suggest: { show: boolean; savePerRoundYuan: number } | null;
  /** 上下文占用百分比（未知 → 0） */
  ctxPct: number;
  /** 「有正用量但缺 provider」的 result 条数（旧版 pi-subagent；面板常驻提示用） */
  subagentMissingProvider: number;
  /** 「跨 cwd 未纳入共享闸门」的子代理次数（面板常驻提示用） */
  subagentCrossCwd: number;
  budget: BudgetStateOut;
}

/** 面板依赖注入（index 组装并调用；本文件不 import index 运行时，防循环 import） */
export interface PanelDeps {
  /** 会话级内存态（cfg/hidden/sessionBudget 等；面板读写与 index 共享同一对象） */
  state: RadarState;
  /** 配置基目录（saveConfig / cfgPath 展示） */
  cfgDir: string;
  /** 面板/状态行同源数据现算（index.buildPanelData，口径唯一实现） */
  buildPanelData(ctx: ExtensionContext): PanelViewData;
  /** 状态行刷新（index.refresh；非 TUI/隐藏时内部自守卫） */
  refresh(ctx: ExtensionContext): void;
  /** 状态行显示开关（/cost off|on 与设置页共用） */
  switchStatus(on: boolean, ctx: ExtensionContext): void;
}

/** 预算页动作列表（0.3.0：默认预算 set/clear + 本会话预算 setSession/clearSession） */
export const BUDGET_ACTIONS: { value: string; label: string }[] = [
  { value: "set", label: "💰 设置默认预算…（/cost budget ¥N 同语义，存配置）" },
  { value: "setSession", label: "💰 设置本会话预算…（仅本会话，覆盖默认；/new 回落）" },
  { value: "clearDefault", label: "🧹 清除默认预算（回到未启用）" },
  { value: "clearSession", label: "↩️ 清除本会话预算（回落默认）" },
];

/** 金额紧凑展示：≥1 → 两位小数；0<y<1 → ≤3 位去尾零（0.870→0.87、0.030→0.03）；0→"0"。
 * index 状态行（≤45 压缩）与本文件面板共用，故随面板侧实现并导出。 */
export function fmtAmt(y: number): string {
  if (y === 0) return "0";
  if (y > 0 && y < 1) {
    const t = fmtYuan(y).replace(/0+$/, "").replace(/\.$/, "");
    return t === "" ? "0" : t;
  }
  return fmtYuan(y);
}

/** 子代理汇总行（无子代理且无缺 provider/跨 cwd → null）。金额复用 fmtYuan 与账本其余行一致。 */
export function formatSubagentLine(
  s: { count: number; yuan: number; unpriced: number },
  missingProvider: number,
  crossCwd = 0,
): string | null {
  const base = s.count > 0
    ? `子代理（${s.count} 次）¥${fmtYuan(s.yuan)}${s.unpriced > 0 ? ` （${s.unpriced} 条未收录不计）` : ""}`
    : "";
  const miss = missingProvider > 0
    ? `${missingProvider} 条缺少 provider 未计入（需升级 pi-subagent）`
    : "";
  // 跨 cwd 子代理不受父闸门限制（check 返回 limit:null），提示但不误拦
  const cross = crossCwd > 0 ? `${crossCwd} 次子代理未纳入共享闸门` : "";
  if (!base && !miss && !cross) return null;
  return [base, miss, cross].filter(Boolean).join(" ｜ ");
}

// ── 面板通用纯辅助（schema 驱动录入计划 / 展示，无 pi/状态依赖）──────────

/** HH:MM 合法性（与 adapters/types.parseHHMM 同规则，供录入向导即时校验） */
function isHHMM(s: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59;
}

/** number 录入解析：返回 {ok,value} 或 {ok:false,error}；空串 → 保留当前（keep） */
export function parseNumberField(
  raw: string,
  cur: number,
  f: { min?: number; max?: number },
): { ok: true; keep: boolean; value: number } | { ok: false; error: string } {
  const s = raw.trim();
  if (s === "") return { ok: true, keep: true, value: cur };
  const n = Number(s);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `“${s}” 不是有效数字` };
  }
  if (f.min !== undefined && n < f.min) {
    return { ok: false, error: `不能小于 ${f.min}` };
  }
  if (f.max !== undefined && n > f.max) {
    return { ok: false, error: `不能大于 ${f.max}` };
  }
  return { ok: true, keep: false, value: n };
}

/** windowList 覆盖值形变守卫：默认/覆盖中的时段数组必须是 [{start,end}…] */
function isWindowArray(v: ParamValue | undefined): v is { start: string; end: string }[] {
  return (
    Array.isArray(v) &&
    v.every((w) => {
      const o = w as { start?: unknown; end?: unknown };
      return o !== null && typeof o === "object" && typeof o.start === "string" && typeof o.end === "string";
    })
  );
}

/**
 * 录入向导的扁平字段计划（随 schema 递归，group 子字段带路径前缀）：
 * 只收录 schema 声明键——zone/weekdaysOnly/_meta 等「不可覆盖键」天然不进入。
 */
interface WizEntry {
  /** 展示/收集路径（group 递归时为 "valley.offPeakFactor" 式点分路径） */
  path: string;
  kind: "number" | "windowList";
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  /** number：当前生效值；windowList：当前生效时段数组 */
  cur: number | { start: string; end: string }[];
}

export function collectWizEntries(schema: ParamSchema, cur: Record<string, ParamValue>, prefix: string, out: WizEntry[]): void {
  for (const key of Object.keys(schema)) {
    const field = schema[key];
    const cv = cur[key];
    if (field.kind === "number") {
      out.push({
        path: prefix + key,
        kind: "number",
        label: field.label,
        unit: field.unit,
        min: field.min,
        max: field.max,
        cur: typeof cv === "number" && Number.isFinite(cv) ? cv : 0,
      });
    } else if (field.kind === "windowList") {
      out.push({
        path: prefix + key,
        kind: "windowList",
        label: field.label,
        cur: isWindowArray(cv) ? cv : [],
      });
    } else {
      // group：递归子字段（当前内置行无 group，按契约支持后续扩展）
      collectWizEntries(
        field.schema,
        cv !== undefined && typeof cv === "object" && cv !== null && !Array.isArray(cv)
          ? (cv as Record<string, ParamValue>)
          : {},
        prefix + key + ".",
        out,
      );
    }
  }
}

/** 向导收集结果（点分路径 → 值）按 schema 还原为嵌套覆盖对象（仅 schema 键） */
export function assembleWizOverride(schema: ParamSchema, flat: Map<string, ParamValue>, path = ""): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const key of Object.keys(schema)) {
    const field = schema[key];
    if (field.kind === "group") {
      const child = assembleWizOverride(field.schema, flat, path + key + ".");
      if (Object.keys(child).length > 0) out[key] = child;
    } else {
      const v = flat.get(path + key);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

// ── 面板主体（showPanel，录入/预设状态机）──────────────────────

/**
 * /cost 无参数 → 五页交互面板（任务 9 整体替换任务 8 占位）。
 *
 * 交互模型（参考 zh-hotkeys 三级状态机 + 分页模式）：
 * - 顶部 nav：←/→ 翻页（tui.editor.cursorLeft/Right 即左右键绑定），Esc 逐级返回；
 * - 正文 = 信息行 + （可选）SelectList 动作列表；列表内 Enter 执行、Esc 返回上级；
 * - 文本录入（数字/HH:MM/预设名）用面板内嵌录入态，不叠 ctx.ui.input 弹窗
 *   （叠弹窗会先把本 custom 组件移出 editorContainer，面板无法继续渲染）；
 * - 非法值一律拒绝并回显原因（设计 §11），绝不静默写入；
 * - 写回一律经 config 函数 + saveConfig；面板数据每次现算（buildPanelData）+ refresh
 *   状态行，天然与状态行同源。
 */

export async function showPanel(deps: PanelDeps, ctx: ExtensionCommandContext): Promise<void> {
  const { state, cfgDir, refresh, switchStatus, buildPanelData } = deps;
  await ctx.ui.custom((tui: any, theme: any, kb: any, done: any) => {
    // ── 五页定义 ──────────────────────────────────────────────
    const PAGES = [
      { id: "overview", title: "总览" },
      { id: "ledger", title: "账本" },
      { id: "budget", title: "预算" },
      { id: "pricing", title: "单价" },
      { id: "settings", title: "设置" },
    ] as const;
    type PageId = (typeof PAGES)[number]["id"];

    // ── 面板状态 ──────────────────────────────────────────────
    let pageIdx = 0;
    /** pricing 页内部层级：rows=型号列表 / rowMenu=行动作 / presets=预设列表 / presetMenu=预设动作 */
    type PricingView = "rows" | "rowMenu" | "presets" | "presetMenu";
    let pricingView: PricingView = "rows";
    let pricingRowKey: string | null = null; // rowMenu/presetMenu 归属行
    let presetName: string | null = null;    // presetMenu 归属预设
    /** 单行提示（保存成功/错误），随下次页面切换清除 */
    let notice = "";
    /** 内嵌文本录入态（无此态时=普通导航） */
    let input: InputCtl | null = null;
    /** 二次确认态（Enter 确认 / Esc 取消） */
    let confirm: { message: string; onOk: () => void } | null = null;
    /** 单价录入向导态（win=null 表示在普通字段间推进；非 null 表示逐窗阶段） */
    let wizard: Wizard | null = null;
    /** 当前活动 SelectList（视图切换时按需重建，实例跨渲染存活） */
    let currentList: SelectList | null = null;
    let currentListKey = "";

    // SelectList 主题（与 zh-hotkeys 一致）
    const listTheme = {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    };

    /** 面板数据（每次现算；写回后自动反映） */
    function viewData(): PanelViewData {
      return buildPanelData(ctx);
    }

    // ── 通用小工具 ─────────────────────────────────────────────
    function cfgPath(): string {
      return path.join(cfgDir, CONFIG_FILENAME);
    }

    /** 写配置统一入口：catch 后 notify + 面板 notice，不抛出 */
    function persistConfig(): boolean {
      try {
        saveConfig(cfgDir, state.cfg);
        return true;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`cost-radar 配置写入失败：${m}`, "error");
        setNotice(`⚠️ 配置写入失败：${m}`);
        return false;
      }
    }

    function setNotice(text: string): void {
      notice = text;
      tui.requestRender();
    }

    // ── 主题配色小工具 ─────────────────────────────────────────
    const label = (t: string) => theme.fg("dim", t);
    const txt = (t: string) => theme.fg("text", t);
    const accent = (t: string) => theme.fg("accent", t);
    const muted = (t: string) => theme.fg("muted", t);
    const warn = (t: string) => theme.fg("warning", t);
    const errTxt = (t: string) => theme.fg("error", t);
    const okTxt = (t: string) => theme.fg("success", t);

    /** 预算 tier → 颜色 */
    function tierWrap(b: BudgetStateOut, s: string): string {
      if (b.tier === "over") return errTxt(s);
      if (b.tier === "warn") return warn(s);
      return s;
    }

    /** 行集合截断保宽（zh-hotkeys 同法：超宽行会让 pi-tui 渲染器抛错） */
    function fit(lines: string[], w: number): string[] {
      return lines.map((line) => (visibleWidth(line) > w ? truncateToWidth(line, w, "") : line));
    }

    function hasOverride(key: string): boolean {
      return Object.prototype.hasOwnProperty.call(state.cfg.priceOverrides, key);
    }

    /** 当前 pricing 归属行（rowMenu/presetMenu 用） */
    function currentRow(): RowSpec | undefined {
      return pricingRowKey ? listRows().find((r) => r.key === pricingRowKey) : undefined;
    }

    // ── 视图与 SelectList 生命周期 ─────────────────────────────
    /** 当前视图标识：变化即重建活动列表（重建会重置选中项，zh-hotkeys 同法） */
    function viewKey(): string {
      switch (PAGES[pageIdx].id as PageId) {
        case "budget":
          return "budget";
        case "settings":
          return "settings";
        case "pricing":
          return `pricing:${pricingView}:${pricingRowKey ?? ""}:${presetName ?? ""}`;
        default:
          return PAGES[pageIdx].id;
      }
    }

    function makeActionList(items: SelectItem[], onSelect: (v: string) => void, onCancel: () => void): SelectList {
      const list = new SelectList(items, Math.min(Math.max(items.length, 1), 9), listTheme);
      list.onSelect = (item) => onSelect(String(item.value));
      list.onCancel = onCancel;
      return list;
    }

    function rebuildListIfNeeded(): void {
      const key = viewKey();
      if (key === currentListKey) return;
      currentListKey = key;
      currentList = buildListForView(key);
    }

    function buildListForView(key: string): SelectList | null {
      if (key === "budget") {
        return makeActionList(BUDGET_ACTIONS, (v) => onBudgetAction(v), () => done(null));
      }
      if (key === "settings") {
        return makeActionList(
          [
            { value: "usdRate", label: "💱 修改 USD→¥ 汇率…" },
            { value: "off", label: "🙈 隐藏状态行（/cost off）" },
            { value: "on", label: "👁 显示状态行（/cost on）" },
          ],
          (v) => onSettingsAction(v),
          () => done(null),
        );
      }
      if (key === "pricing:rows::") {
        const rows = listRows();
        if (rows.length === 0) return null;
        const items: SelectItem[] = rows.map((r) => ({
          value: r.key,
          label: r.key,
          description: `${r.currency === "usd" ? "USD" : "CNY"} · ${hasOverride(r.key) ? "已覆盖" : "官方"}`,
        }));
        return makeActionList(
          items,
          (rowKey) => {
            pricingRowKey = rowKey;
            pricingView = "rowMenu";
            notice = "";
            rebuildListIfNeeded();
          },
          () => done(null),
        );
      }
      if (key.startsWith("pricing:rowMenu:")) {
        const rowKey = key.slice("pricing:rowMenu:".length);
        if (!listRows().some((r) => r.key === rowKey)) return null;
        return makeActionList(
          [
            { value: "edit", label: "✏️ 录入单价（按官方字段逐项校验）" },
            { value: "official", label: "↩️ 载入官方默认（清除该行覆盖）" },
            { value: "savePreset", label: "💾 保存为预设…" },
            { value: "presets", label: "🗂 预设管理…" },
            { value: "back", label: "◀ 返回型号列表" },
          ],
          (v) => onRowMenuAction(v),
          () => {
            pricingView = "rows";
            pricingRowKey = null;
            presetName = null;
            rebuildListIfNeeded();
          },
        );
      }
      if (key === "pricing:presets::") {
        const names = listPresets(state.cfg);
        if (names.length === 0) return null;
        return makeActionList(
          names.map((n) => ({
            value: n,
            label: n,
            description: `覆盖 ${Object.keys(state.cfg.userPresets[n] ?? {}).length} 行`,
          })),
          (n) => {
            presetName = n;
            pricingView = "presetMenu";
            rebuildListIfNeeded();
          },
          () => {
            pricingView = "rowMenu";
            rebuildListIfNeeded();
          },
        );
      }
      if (key.startsWith("pricing:presetMenu:")) {
        const name = key.slice("pricing:presetMenu:".length);
        if (!Object.prototype.hasOwnProperty.call(state.cfg.userPresets, name)) return null;
        return makeActionList(
          [
            { value: "apply", label: "📥 载入该预设（覆盖同名行，二次确认）" },
            { value: "delete", label: "🗑 删除该预设（二次确认）" },
            { value: "back", label: "◀ 返回预设列表" },
          ],
          (v) => onPresetMenuAction(name, v),
          () => {
            pricingView = "presets";
            rebuildListIfNeeded();
          },
        );
      }
      return null;
    }

    // ── 页面动作（预算 / 设置 / 行菜单 / 预设菜单） ──────────────
    function onBudgetAction(v: string): void {
      if (v === "set") {
        startNumberCtl({
          title: "设置默认预算（存配置，所有会话共用额度）",
          note: ">0 的金额（¥）；仅影响本会话消耗的额度判定",
          cur: state.cfg.defaultBudget,
          min: 0.01,
          onSubmitKeep: () => cancelInputTo(),
          onSubmit: (n) => {
            leaveInput();
            state.cfg.defaultBudget = n;
            if (!persistConfig()) return;
            refresh(ctx);
            setNotice(`✅ 默认预算已设为 ¥${fmtYuan(n)}`);
          },
          onCancel: () => cancelInputTo(),
        });
        return;
      }
      if (v === "setSession") {
        startNumberCtl({
          title: "设置本会话预算（仅本会话，覆盖默认预算；/new 后回落默认）",
          note: ">0 的金额（¥），可高于或低于默认预算",
          cur: state.sessionBudget,
          min: 0.01,
          onSubmitKeep: () => cancelInputTo(),
          onSubmit: (n) => {
            leaveInput();
            state.sessionBudget = n;
            refresh(ctx);
            setNotice(`✅ 本会话预算已设为 ¥${fmtYuan(n)}（仅本会话；/new 后回落默认预算）`);
          },
          onCancel: () => cancelInputTo(),
        });
        return;
      }
      if (v === "clearDefault") {
        if (state.cfg.defaultBudget === null) {
          setNotice("默认预算本就没设置（当前未启用）");
          return;
        }
        state.cfg.defaultBudget = null;
        if (!persistConfig()) return;
        refresh(ctx);
        setNotice("✅ 默认预算已清除（闸门未启用）");
        return;
      }
      if (v === "clearSession") {
        if (state.sessionBudget === null) {
          setNotice("本会话没有设置预算（当前用默认预算）");
          return;
        }
        state.sessionBudget = null;
        refresh(ctx);
        const fb = state.cfg.defaultBudget;
        setNotice(
          fb === null
            ? "✅ 本会话预算已清除（默认预算未设置，闸门关闭）"
            : `✅ 本会话预算已清除（回落默认预算 ¥${fmtYuan(fb)}）`,
        );
      }
    }

    function onSettingsAction(v: string): void {
      if (v === "usdRate") {
        startNumberCtl({
          title: "修改 USD→¥ 汇率（保存后状态行/金额按新汇率重算）",
          note: "按当前汇率换算 USD 计价族；CNY 族（Moonshot/Qwen）不受影响",
          cur: state.cfg.usdRate,
          min: 0.000001,
          onSubmitKeep: () => cancelInputTo(),
          onSubmit: (n) => {
            leaveInput();
            state.cfg.usdRate = n;
            if (!persistConfig()) return;
            refresh(ctx);
            setNotice(`✅ USD→¥ 汇率已设为 ${n}`);
          },
          onCancel: () => cancelInputTo(),
        });
        return;
      }
      if (v === "off" || v === "on") {
        switchStatus(v === "on", ctx);
        ctx.ui.notify(`cost-radar 状态行已${v === "on" ? "显示" : "隐藏"}`, "info");
        setNotice(v === "on" ? "✅ 状态行已显示" : "状态行已隐藏（/cost on 恢复）");
      }
    }

    function onRowMenuAction(v: string): void {
      const row = currentRow();
      if (!row) {
        setNotice("该行不存在（可能已被移除）");
        return;
      }
      if (v === "edit") {
        startWizard(row);
        return;
      }
      if (v === "official") {
        if (!hasOverride(row.key)) {
          setNotice(`该行没有覆盖，当前就是官方默认价（${row.currency === "usd" ? "USD" : "CNY"}）`);
          return;
        }
        askConfirm(`确认恢复 “${row.key}” 官方默认价？\n该行覆盖将被清除（录入值丢失）`, () => {
          applyOverrides(state.cfg, { [row.key]: null });
          if (!persistConfig()) return;
          refresh(ctx);
          setNotice(`↩️ “${row.key}” 已恢复官方默认价`);
        });
        return;
      }
      if (v === "savePreset") {
        startNameCtl(
          "为当前行覆盖保存为命名预设",
          `保存 “${row.key}” 当前覆盖为预设（无覆盖时保存空快照，语义自洽）`,
          (name) => {
            leaveInput();
            const snapshot = cloneConfigOverrides({ [row.key]: state.cfg.priceOverrides[row.key] ?? {} });
            if (Object.prototype.hasOwnProperty.call(state.cfg.userPresets, name)) {
              // 覆盖现有预设 → 二次确认
              askConfirm(`预设 “${name}” 已存在，是否覆盖？`, () => {
                savePreset(state.cfg, name, snapshot);
                if (!persistConfig()) return;
                refresh(ctx);
                setNotice(`✅ 预设 “${name}” 已更新`);
              });
            } else {
              savePreset(state.cfg, name, snapshot);
              if (!persistConfig()) return;
              refresh(ctx);
              setNotice(`✅ 已保存预设 “${name}”（${row.key}）`);
            }
          },
        );
        return;
      }
      if (v === "presets") {
        pricingView = "presets";
        presetName = null;
        rebuildListIfNeeded();
        return;
      }
      if (v === "back") {
        pricingView = "rows";
        pricingRowKey = null;
        presetName = null;
        rebuildListIfNeeded();
      }
    }

    function onPresetMenuAction(name: string, v: string): void {
      if (v === "apply") {
        const snapshot = state.cfg.userPresets[name];
        if (!snapshot) {
          setNotice("该预设不存在（可能已被删除）");
          pricingView = "presets";
          presetName = null;
          rebuildListIfNeeded();
          return;
        }
        askConfirm(`载入预设 “${name}”？\n其覆盖的 ${Object.keys(snapshot).length} 行将按快照覆盖（可再「载入官方」恢复）`, () => {
          // 载入前逐行防御校验（registry.listRows() 白名单 + 行 schema，与 finishWizard
          // 同款）：预设文件是本地可控输入，历史坏条目/手动篡改一律过滤并提示，绝不整体写入
          const good: Record<string, Record<string, ParamValue>> = {};
          const bad: string[] = [];
          for (const [key, fields] of Object.entries(snapshot)) {
            if (fields === undefined || fields === null || typeof fields !== "object" || Array.isArray(fields)) {
              bad.push(key);
              continue;
            }
            const verdict = validateOverride(listRows(), key, fields);
            if (verdict.ok) good[key] = fields;
            else bad.push(`${key}（${verdict.errors[0] ?? "字段非法"}）`);
          }
          if (bad.length > 0) {
            ctx.ui.notify(`预设 “${name}” 跳过 ${bad.length} 行非法条目：${bad.join("；")}`, "warning");
          }
          if (Object.keys(good).length === 0) {
            if (bad.length === 0) {
              // 空快照：无覆盖行可载入，保持原语义（无害 no-op，无需落盘）
              setNotice(`📥 预设 “${name}” 已载入（空快照，无覆盖改动）`);
              return;
            }
            // 全部非法：复位视图回预设列表，不留 presetMenu 悬空态（🟡2b）
            setNotice(`⚠️ 预设 “${name}” 无任何合法覆盖行可载入（${bad.length} 行全部被过滤）`);
            pricingView = "presets";
            presetName = null;
            rebuildListIfNeeded();
            return;
          }
          applyOverrides(state.cfg, good);
          if (!persistConfig()) {
            // 落盘失败：先复位视图回预设列表再留 ⚠️（persistConfig 已 setNotice）
            pricingView = "presets";
            presetName = null;
            rebuildListIfNeeded();
            return;
          }
          refresh(ctx);
          setNotice(`📥 预设 “${name}” 已载入（${Object.keys(good).length} 行）`);
        });
        return;
      }
      if (v === "delete") {
        askConfirm(`确认删除预设 “${name}”？\n（删除后不可恢复）`, () => {
          if (removePreset(state.cfg, name)) {
            const persisted = persistConfig();
            if (persisted) setNotice(`🗑 预设 “${name}” 已删除`);
            // 落盘失败：persistConfig 已置 ⚠️；视图统一复位回预设列表（不早退留悬空态，🟡2b）
          } else {
            setNotice("该预设不存在");
          }
          pricingView = "presets";
          presetName = null;
          rebuildListIfNeeded();
        });
        return;
      }
      if (v === "back") {
        pricingView = "presets";
        presetName = null;
        rebuildListIfNeeded();
      }
    }

    // ── 二次确认态 ─────────────────────────────────────────────
    function askConfirm(message: string, onOk: () => void): void {
      confirm = { message, onOk };
      tui.requestRender();
    }

    // ── 内嵌文本录入态（number / HH:MM / 预设名共用） ────────────
    interface InputCtl {
      title: string;
      note: string;
      buffer: string;
      error: string | null;
      onSubmit: (raw: string) => void;
      onCancel: () => void;
    }

    function startCtl(opts: {
      title: string;
      note?: string;
      prefill?: string;
      onSubmit: (raw: string) => void;
      onCancel: () => void;
    }): void {
      input = {
        title: opts.title,
        note: opts.note ?? "",
        buffer: opts.prefill ?? "",
        error: null,
        onSubmit: opts.onSubmit,
        onCancel: opts.onCancel,
      };
      tui.requestRender();
    }

    /** 数字录入：留空=保留当前（onSubmitKeep）；非法拒绝并回显（类型/min/max） */
    function startNumberCtl(opts: {
      title: string;
      note?: string;
      cur: number | null;
      min?: number;
      max?: number;
      onSubmitKeep: () => void;
      onSubmit: (n: number) => void;
      onCancel: () => void;
    }): void {
      const cur = opts.cur ?? 0;
      const curNote = opts.cur !== null ? `当前 ${cur}，留空=保留` : "";
      startCtl({
        title: opts.title,
        note: [opts.note ?? "", curNote].filter((s) => s !== "").join("；"),
        onSubmit: (raw) => {
          const r = parseNumberField(raw, cur, { min: opts.min, max: opts.max });
          if (r.ok === false) {
            if (input) input.error = r.error;
            tui.requestRender();
            return;
          }
          if (r.keep) {
            opts.onSubmitKeep();
            return;
          }
          opts.onSubmit(r.value);
        },
        onCancel: opts.onCancel,
      });
    }

    /** 预设名录入：非空/长度/安全校验 */
    function startNameCtl(title: string, note: string, onOk: (name: string) => void): void {
      startCtl({
        title,
        note,
        onSubmit: (raw) => {
          const name = raw.trim();
          if (name === "") {
            if (input) input.error = "预设名不能为空";
            tui.requestRender();
            return;
          }
          if (name.length > 60) {
            if (input) input.error = "预设名过长（≤60 字符）";
            tui.requestRender();
            return;
          }
          if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
            if (input) input.error = "预设名不能含 / \\ 或以 . 开头";
            tui.requestRender();
            return;
          }
          if (name === "__proto__" || name === "constructor" || name === "prototype") {
            if (input) input.error = "该名称为保留键，不能使用";
            tui.requestRender();
            return;
          }
          onOk(name);
        },
        onCancel: () => cancelInputTo(),
      });
    }

    /** 录入取消统一出口：清 input（无操作，停留在当前视图） */
    function cancelInputTo(): void {
      input = null;
      tui.requestRender();
    }

    /**
     * 录入提交收尾：先退出 input 态再给反馈（成功 notice / 二次确认 / 失败 ⚠️）。
     * 否则确认框与键盘仍被 input 截获——Enter 反复重放 onSubmit 永不进入 onOk、
     * Esc-Enter 误触可意外覆盖既有预设（code-reviewer 🟡1）。
     */
    function leaveInput(): void {
      input = null;
      tui.requestRender();
    }

    // ── 单价录入向导（schema 驱动；windowList 走逐窗子阶段） ─────
    interface WizWin {
      /** 正在编辑的时段数组（原始列表拷贝；收尾时深拷贝写回 flat） */
      arr: { start: string; end: string }[];
      /** 目标时段个数（count 子阶段确定） */
      n: number;
      /** 当前编辑窗口下标 */
      i: number;
      /** 下一子阶段：count=问个数 / start=问开始 / end=问结束 */
      sub: "count" | "start" | "end";
    }
    interface Wizard {
      row: RowSpec;
      items: WizEntry[];
      idx: number;
      /** 已收集值：number 路径 → 值；windowList 收尾写时段数组 */
      flat: Map<string, ParamValue>;
      currencyNote: string;
      /** windowList 逐窗编辑中（非 null 时向导停留在某 windowList 字段内） */
      win: WizWin | null;
    }

    function startWizard(row: RowSpec): void {
      const cur = mergeParamsDeep(row.defaults, state.cfg.priceOverrides[row.key] ?? null);
      const items: WizEntry[] = [];
      collectWizEntries(row.schema, cur, "", items);
      if (items.length === 0) {
        setNotice("该行无可录入参数（全部字段为固定官方语义）");
        return;
      }
      const currencyNote =
        row.currency === "usd"
          ? `按 USD/M 录入，状态行按当前汇率（${state.cfg.usdRate}）换算 ¥`
          : "按 ¥/M 直接录入";
      wizard = { row, items, idx: 0, flat: new Map(), currencyNote, win: null };
      wizardNext();
    }

    /** 推进向导：field 阶段 → 数字录入或 windowList 子阶段；全部完成 → 写回 */
    function wizardNext(): void {
      const w = wizard;
      if (!w) return;
      if (w.win) return; // 逐窗子阶段由 askWin* 驱动
      if (w.idx >= w.items.length) {
        finishWizard(w);
        return;
      }
      const it = w.items[w.idx];
      if (it.kind === "windowList") {
        const list = (it.cur as { start: string; end: string }[]).map((x) => ({ start: x.start, end: x.end }));
        w.win = { arr: list, n: list.length, i: 0, sub: "count" };
        askWinCount();
        return;
      }
      startNumberCtl({
        title: `${it.label}${it.unit ? `（${it.unit}）` : ""}`,
        note: "留空=保留当前值 · Esc 中止整次录入",
        cur: typeof it.cur === "number" ? it.cur : 0,
        min: it.min,
        max: it.max,
        onSubmitKeep: () => {
          const w3 = wizard;
          if (w3 && !w3.win) {
            w3.flat.set(it.path, it.cur as number);
            w3.idx += 1;
            wizardNext();
          }
        },
        onSubmit: (n) => {
          const w3 = wizard;
          if (w3 && !w3.win) {
            w3.flat.set(it.path, n);
            w3.idx += 1;
            wizardNext();
          }
        },
        onCancel: () => abortWizard(),
      });
    }

    /** windowList 子阶段文案前缀（含时段上下文，便于逐窗确认） */
    function winNote(win: WizWin): string {
      if (win.arr.length === 0) return "当前无时段";
      return `当前 ${win.arr.length} 段：${win.arr.map((x) => `${x.start}–${x.end}`).join("，")}`;
    }

    /** count：问时段个数（≥1，留空=保持现有数量；减少=删尾部、增多=后续补录） */
    function askWinCount(): void {
      const w = wizard;
      const win = w?.win;
      if (!w || !win || win.sub !== "count") return;
      const it = w.items[w.idx];
      startCtl({
        title: `${it.label}：时段个数（HH:MM 对）`,
        note: `${winNote(win)}（UTC；留空=保持；减少将删除尾部时段）`,
        onSubmit: (raw) => {
          const s = raw.trim();
          let n: number;
          if (s === "") {
            if (win.arr.length === 0) {
              if (input) input.error = "时段个数不能为空（当前无任何时段）";
              tui.requestRender();
              return;
            }
            n = win.arr.length;
          } else {
            n = Number(s);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
              if (input) input.error = `“${s}” 不是 ≥1 的整数`;
              tui.requestRender();
              return;
            }
          }
          win.n = n;
          win.arr = win.arr.slice(0, n);
          win.i = 0;
          win.sub = "start";
          askWinStart();
        },
        onCancel: () => abortWizard(),
      });
    }

    /** start：编辑第 i 段开始时刻（已有窗口留空=沿用；新窗口必填） */
    function askWinStart(): void {
      const w = wizard;
      const win = w?.win;
      if (!w || !win || win.sub !== "start") return;
      if (win.i >= win.n) {
        // 全部时段已录完 → 写回该字段并推进到下一字段
        const it = w.items[w.idx];
        w.flat.set(it.path, win.arr.map((x) => ({ start: x.start, end: x.end })));
        w.idx += 1;
        w.win = null;
        wizardNext();
        return;
      }
      const it = w.items[w.idx];
      const existing = win.arr[win.i];
      const isNew = existing === undefined;
      startCtl({
        title: `${it.label} 第 ${win.i + 1}/${win.n} 段开始（HH:MM，UTC）`,
        note: isNew ? "新时段：开始必填（24h 制；跨午夜窗正常）" : `当前 ${existing.start}，留空=沿用`,
        onSubmit: (raw) => {
          const s = raw.trim();
          if (s === "") {
            if (!isNew) {
              win.sub = "end";
              askWinEnd();
              return;
            }
            if (input) input.error = "新时段开始时刻必填（HH:MM）";
            tui.requestRender();
            return;
          }
          if (!isHHMM(s)) {
            if (input) input.error = `“${s}” 不是合法 HH:MM（24h 制）`;
            tui.requestRender();
            return;
          }
          if (isNew) win.arr.push({ start: s, end: "" });
          else win.arr[win.i] = { ...existing, start: s };
          win.sub = "end";
          askWinEnd();
        },
        onCancel: () => abortWizard(),
      });
    }

    /** end：编辑第 i 段结束时刻，成功后推进到下一段或收尾 */
    function askWinEnd(): void {
      const w = wizard;
      const win = w?.win;
      if (!w || !win || win.sub !== "end") return;
      const it = w.items[w.idx];
      const cur = win.arr[win.i];
      startCtl({
        title: `${it.label} 第 ${win.i + 1}/${win.n} 段结束（HH:MM，UTC）`,
        note: cur && cur.end ? `当前 ${cur.end}，留空=沿用；end≤start 视为跨午夜` : "结束必填（HH:MM）",
        onSubmit: (raw) => {
          const s = raw.trim();
          if (s === "") {
            if (cur && cur.end) {
              win.i += 1;
              win.sub = "start";
              askWinStart();
              return;
            }
            if (input) input.error = "新时段结束时刻必填（HH:MM）";
            tui.requestRender();
            return;
          }
          if (!isHHMM(s)) {
            if (input) input.error = `“${s}” 不是合法 HH:MM（24h 制）`;
            tui.requestRender();
            return;
          }
          win.arr[win.i] = cur ? { ...cur, end: s } : { start: "", end: s };
          win.i += 1;
          win.sub = "start";
          askWinStart();
        },
        onCancel: () => abortWizard(),
      });
    }

    /** 中止向导（Esc）：清向导态回行动作页 */
    function abortWizard(): void {
      input = null;
      wizard = null;
      setNotice("已中止录入（未保存任何改动）");
      if (PAGES[pageIdx].id === "pricing") {
        pricingView = "rowMenu";
        rebuildListIfNeeded();
      }
    }

    /** 收尾：schema 还原嵌套覆盖 → validateOverride → 写配置 → 刷新 */
    function finishWizard(w: Wizard): void {
      const override = assembleWizOverride(w.row.schema, w.flat);
      const verdict = validateOverride(listRows(), w.row.key, override);
      if (!verdict.ok) {
        // 防御：向导只产出 schema 键且值均经校验，理论不可达
        wizard = null;
        input = null;
        ctx.ui.notify(`覆盖校验未通过：${verdict.errors.join("；")}`, "error");
        setNotice(`⚠️ ${verdict.errors[0] ?? "校验失败"}`);
        return;
      }
      applyOverrides(state.cfg, { [w.row.key]: override });
      if (!persistConfig()) {
        wizard = null;
        input = null;
        return;
      }
      refresh(ctx);
      wizard = null;
      input = null;
      setNotice(`✅ “${w.row.key}” 单价已保存（${w.currencyNote}）`);
      if (PAGES[pageIdx].id === "pricing") {
        pricingView = "rowMenu";
        rebuildListIfNeeded();
      }
    }

    /** 覆盖/预设快照深拷贝（不共享引用；值仅 JSON 类型） */
    function cloneConfigOverrides(v: Record<string, Record<string, ParamValue>>): Record<string, Record<string, ParamValue>> {
      return JSON.parse(JSON.stringify(v)) as Record<string, Record<string, ParamValue>>;
    }

    // ── 页头/兜底行 ────────────────────────────────────────────
    function navLine(): string {
      const parts = PAGES.map((p, i) => {
        const nm = `${i + 1}${p.title}`;
        return i === pageIdx ? accent(theme.bold(nm)) : muted(nm);
      });
      return ` ${accent("⛽ cost-radar")} ${theme.fg("dim", "◀")} ${parts.join(muted(" · "))} ${theme.fg("dim", "▶")}`;
    }

    /** 正文兜底行：按键提示 + 当前 notice */
    function footerLine(hint: string): string {
      const n = notice !== "" ? `  ${warn(notice)}` : "";
      return ` ${theme.fg("dim", hint)}${n}`;
    }

    // ── 各页正文渲染 ────────────────────────────────────────────
    /** overview 页正文（与状态行同源 buildPanelData） */
    function overviewLines(): string[] {
      const d = viewData();
      const lines: string[] = [];
      const modelLabel = d.model ? `${d.model.provider}/${d.model.id}` : "（未知）";
      lines.push(` ${label("当前模型：")}${txt(modelLabel)} ${d.covered ? okTxt("✓已收录") : warn("✗未收录（金额不计，仅记 token）")}`);
      if (!d.hasUsage) {
        lines.push(` ${muted("⛽ 暂无 usage 数据（新会话或刚 compact）——回合开始后自动出现")}`);
      } else {
        const spendTxt = d.covered ? txt(`¥${fmtYuan(d.ledger.spendYuan)}`) : warn("⛽未收录（只计 token 不计金额）");
        lines.push(` ${label("累计：")}${spendTxt}${label("（本会话已归属可计金额）")}`);
        if (!d.covered) {
          lines.push(` ${label("三档预估：")}${muted("续-/冷-/新-（未收录无法估价）")}`);
        } else if (d.usage !== null && d.forecast) {
          const f = d.forecast;
          lines.push(
            ` ${label("三档预估：")}${txt(`续热 ¥${fmtAmt(f.hot)} · 续冷 ¥${fmtAmt(f.cold)} · 新会话 ¥${fmtAmt(f.fresh)}`)}${label("（每轮/次）")}`,
          );
          if (d.cache) {
            const ph =
              d.cache.phase === "warm"
                ? `⚡${fmtClock(d.cache.secondsLeft ?? 0)} 倒计时中（命中免写价）`
                : d.cache.phase === "expired"
                  ? "🧊 已过期（继续会话走冷价）"
                  : d.cache.phase === "rebuilding"
                    ? "♻️ 重建中（走写价）"
                    : "—";
            lines.push(` ${label("缓存相位：")}${txt(ph)}`);
          } else {
            lines.push(` ${label("缓存相位：")}${muted("—（该模型无缓存语义或无最近一轮）")}`);
          }
        }
      }
      if (d.valley) lines.push(` ${label("谷时：")}${okTxt("🌙 当前命中谷时优惠（DeepSeek off-peak 半价）")}`);
      // 预算（budget 口径，与状态行同源）
      if (d.budget.enabled) {
        const limitSrc = state.sessionBudget !== null ? "本会话预算" : "默认预算";
        const limit = state.sessionBudget ?? state.cfg.defaultBudget ?? 0;
        lines.push(` ${label("预算：")}${tierWrap(d.budget, `${d.budget.pct}% 已用（¥${fmtYuan(d.ledger.spendYuan)} / ¥${fmtYuan(limit)}，${limitSrc}）`)}`);
      } else {
        lines.push(` ${label("预算：")}${muted("未启用（默认预算已清除）")}`);
      }
      // 上下文占用
      const cu = ctx.getContextUsage();
      const ctxTxt =
        cu && cu.percent !== null
          ? `${Math.round(cu.percent)}%（${fmtTokens(cu.tokens ?? 0)}/${fmtTokens(cu.contextWindow)} tokens）`
          : "未知（刚 compact 或尚无响应）";
      lines.push(` ${label("上下文占用：")}${txt(ctxTxt)}`);
      // 💡 建议 + 为什么
      if (d.suggest && d.covered && d.usage !== null && d.forecast) {
        if (d.suggest.show) {
          const save = d.suggest.savePerRoundYuan;
          lines.push(` ${accent(theme.bold("💡 建议开新会话"))}${save > 0 ? `（每轮约省 ¥${fmtAmt(save)}）` : ""}`);
          lines.push(` ${label("  为什么：")}${txt(suggestWhy(d.ctxPct, d.forecast.fresh, d.forecast.cold))}`);
        } else {
          lines.push(` ${label("💡 开新会话建议：")}${muted(suggestWhyNot(d.ctxPct, d.forecast.fresh, d.forecast.cold))}`);
        }
      } else if (d.covered && !d.hasUsage) {
        lines.push(` ${muted("💡 开新会话建议：暂无历史，先跑几轮再评估")}`);
      }
      // ⏸ 暂停当前回合（streaming 中；任务 10 暂停联动的直接入口，ctx.abort() 现版本可用）
      if (isStreaming()) {
        lines.push(` ${warn("⏸ 暂停当前回合（Enter 触发——仅中断本次运行，已产出内容保留）")}`);
      }
      return lines;
    }

    function isStreaming(): boolean {
      return ctx.signal !== undefined || ctx.hasPendingMessages();
    }

    /** ledger 页正文：perModel 表（模型行 ¥ + token 明细）+ 无归属/未收录标注 */
    function ledgerLines(): string[] {
      const d = viewData();
      const lines: string[] = [];
      // 子代理汇总/缺 provider 常驻行：即使 hasUsage===false（旧版 pi-subagent 用量
      // 未计入 rawTokens）也必须渲染（设计 §7.1 第 1 处 / E7）。
      const subLine = formatSubagentLine(d.ledger.subagent, d.subagentMissingProvider, d.subagentCrossCwd);
      if (!d.hasUsage) {
        if (subLine) lines.push(` ${muted(subLine)}`);
        lines.push(` ${muted("（本会话还没有任何 usage 记录）")}`);
        return lines;
      }
      if (!d.ledger.allCovered) {
        lines.push(` ${warn("⚠️ 有归属模型未被计价清单收录 → 该部分金额不计（可等插件更新收录）")}`);
      }
      const keys = Object.keys(d.ledger.perModel).sort((a, b) => {
        const y = d.ledger.perModel[b].yuan - d.ledger.perModel[a].yuan;
        return y !== 0 ? y : a.localeCompare(b);
      });
      if (keys.length === 0) {
        lines.push(` ${muted("（全部条目均无归属或未收录，无 perModel 明细）")}`);
      }
      const MAX_ROWS = 8;
      for (const key of keys.slice(0, MAX_ROWS)) {
        const m = d.ledger.perModel[key];
        const t = m.tokens;
        lines.push(` ${txt(key)}${label("  ¥")}${txt(fmtYuan(m.yuan))}`);
        lines.push(`   ${label(`in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · 缓存读 ${fmtTokens(t.cacheRead)} · 缓存写 ${fmtTokens(t.cacheWrite)}`)}`);
      }
      if (keys.length > MAX_ROWS) {
        lines.push(` ${muted(`…（还有 ${keys.length - MAX_ROWS} 个模型，按金额只列前 ${MAX_ROWS}）`)}`);
      }
      const un = d.ledger.unallocatedTokens;
      const unTotal = un.input + un.output + un.cacheRead + un.cacheWrite;
      if (unTotal > 0) {
        lines.push(` ${label(`无归属工具 token：${fmtTokens(unTotal)}`)}${muted("（工具执行 token 不计金额）")}`);
      }
      const raw = d.ledger.rawTokens;
      lines.push(
        ` ${label(`会话 token 总量：in ${fmtTokens(raw.input)} · out ${fmtTokens(raw.output)} · 缓存读 ${fmtTokens(raw.cacheRead)} · 缓存写 ${fmtTokens(raw.cacheWrite)}`)}`,
      );
      if (subLine) lines.push(` ${muted(subLine)}`);
      return lines;
    }

    /** budget 页正文信息行（动作列表在其后渲染） */
    function budgetHead(): string[] {
      const d = viewData();
      const head: string[] = [];
      const def = state.cfg.defaultBudget;
      head.push(` ${label("默认预算：")}${def === null ? muted("未设置（已显式关闭）") : txt(`¥${fmtYuan(def)}（存配置，全局会话共用）`)}`);
      const ovr = state.sessionBudget;
      head.push(` ${label("本会话预算：")}${ovr === null ? muted("无（跟默认预算）") : txt(`¥${fmtYuan(ovr)}（覆盖默认；/new 回落）`)}`);
      if (d.budget.enabled) {
        const limit = ovr ?? def ?? 0;
        head.push(` ${label("已花费：")}${tierWrap(d.budget, `¥${fmtYuan(d.ledger.spendYuan)} / ¥${fmtYuan(limit)}（${d.budget.pct}%）`)}`);
        const lvl = d.budget.tier === "over" ? "已超支" : d.budget.tier === "warn" ? "接近上限（≥80%）" : "正常";
        head.push(` ${label("色阶：")}${tierWrap(d.budget, lvl)}`);
      } else {
        head.push(` ${label("已花费：")}${txt(`¥${fmtYuan(d.ledger.spendYuan)}`)}${muted("（未启用额度）")}`);
      }
      return head;
    }

    /** settings 页正文信息行（动作列表在其后渲染） */
    function settingsHead(): string[] {
      const head: string[] = [];
      head.push(` ${label("USD→¥ 汇率：")}${txt(String(state.cfg.usdRate))}`);
      head.push(`   ${muted("按当前汇率换算 USD 计价族（DeepSeek/Anthropic/OpenAI）；CNY 族（Moonshot/Qwen）不受影响")}`);
      head.push(` ${label("状态行：")}${state.hidden ? warn("已隐藏（/cost on 恢复）") : okTxt("显示中")}`);
      head.push(` ${label("配置路径：")}${muted(cfgPath())}`);
      return head;
    }

    /** pricing 各视图信息行（列表/提示在其后渲染） */
    function pricingHead(): string[] {
      const head: string[] = [];
      const row = currentRow();
      if (pricingView === "rows") {
        head.push(` ${label(`内置计价清单（共 ${listRows().length} 行）——选中行可改价/恢复官方/存预设`)}`);
      } else if (pricingView === "rowMenu" && row) {
        head.push(` ${accent(theme.bold(` ${row.key} `))}`);
        head.push(
          ` ${label("币种/状态：")}${txt(row.currency === "usd" ? "USD（按 usdRate 折算 ¥）" : "CNY（¥ 直接计价）")} · ${
            hasOverride(row.key) ? warn("已覆盖") : okTxt("官方默认")
          }`,
        );
        const cur = mergeParamsDeep(row.defaults, state.cfg.priceOverrides[row.key] ?? null);
        const meta = cur._meta;
        if (meta && typeof meta === "object") {
          const mm = meta as { source?: unknown; verifiedAt?: unknown };
          if (typeof mm.source === "string") head.push(` ${label("来源：")}${muted(mm.source)}`);
          if (typeof mm.verifiedAt === "string") head.push(` ${label("核对日期：")}${muted(mm.verifiedAt)}`);
        }
      } else if (pricingView === "presets") {
        const names = listPresets(state.cfg);
        head.push(
          names.length > 0
            ? ` ${label(`用户预设（${names.length}）——载入会按快照覆盖对应行`)}`
            : ` ${muted("（暂无预设——可在行菜单「保存为预设」创建）")}`,
        );
      } else {
        // presetMenu
        const name = presetName ?? "";
        const snapshot = name !== "" ? state.cfg.userPresets[name] : undefined;
        head.push(` ${accent(theme.bold(` 预设：${name} `))}`);
        head.push(` ${label("内容：")}${snapshot ? muted(`${Object.keys(snapshot).length} 行覆盖快照`) : muted("（不存在）")}`);
      }
      return head;
    }

    /** 录入态正文（含错误回显，设计 §11：非法值拒绝并提示） */
    function inputLines(): string[] {
      if (!input) return [];
      const lines: string[] = [];
      lines.push(` ${accent(theme.bold(" 录入（Enter 确认 · Esc 取消）"))}`);
      lines.push(` ${txt(input.title)}`);
      if (input.note) lines.push(` ${muted(input.note)}`);
      lines.push("");
      lines.push(`  ${txt(input.buffer)}${accent("▏")}`);
      if (input.error) {
        lines.push(` ${warn(`✗ ${input.error}`)}`);
      } else {
        lines.push(` ${muted("非法输入会被拒绝并要求重录；数字留空通常=保留当前")}`);
      }
      return lines;
    }

    /** 二次确认态正文 */
    function confirmLines(): string[] {
      if (!confirm) return [];
      const lines: string[] = [];
      lines.push(` ${accent(theme.bold(" 确认操作"))}`);
      for (const part of confirm.message.split("\n")) {
        lines.push(` ${txt(part)}`);
      }
      lines.push("");
      lines.push(` ${okTxt("Enter 确认")} · ${warn("Esc 取消")}`);
      return lines;
    }

    /** 💡 建议理由（show=true） */
    function suggestWhy(ctxPct: number, fresh: number, cold: number): string {
      if (ctxPct > 85) {
        return `上下文已用 ${Math.round(ctxPct)}%（>85%），新会话可重置上下文避免逼近窗口上限`;
      }
      if (cold > fresh * 2 && cold > 0.05) {
        const ratio = fresh > 0 ? (cold / fresh).toFixed(1) : "∞";
        return `续冷 ¥${fmtAmt(cold)} 约为新会话 ¥${fmtAmt(fresh)} 的 ${ratio} 倍，重开更省`;
      }
      return "（条件满足但无明确理由？）"; // 防御占位，show=true 时必有上述二者之一
    }

    /** 💡 建议未触发的原因（show=false） */
    function suggestWhyNot(ctxPct: number, fresh: number, cold: number): string {
      if (ctxPct > 70) {
        return `上下文 ${Math.round(ctxPct)}%（尚未 >85%），暂不提示`;
      }
      if (cold > fresh) {
        return `续冷 ¥${fmtAmt(cold)} 未到新会话 ¥${fmtAmt(fresh)} 的 2 倍，重开不划算`;
      }
      return "新会话档并不低于续冷档，无需重开";
    }

    // ── 渲染主入口 ──────────────────────────────────────────────
    function renderAll(w: number): string[] {
      rebuildListIfNeeded();
      const lines: string[] = [];
      lines.push(theme.fg("accent", "─".repeat(Math.max(1, w))));
      lines.push(navLine());
      if (confirm) {
        lines.push(...confirmLines());
      } else if (input) {
        lines.push(...inputLines());
      } else {
        const id = PAGES[pageIdx].id as PageId;
        if (id === "overview") {
          lines.push(...overviewLines());
          lines.push(footerLine("←→ 翻页 · Enter 暂停回合(streaming) · Esc 关闭"));
        } else if (id === "ledger") {
          lines.push(...ledgerLines());
          lines.push(footerLine("←→ 翻页 · Esc 关闭（账本按当前会话 entries 现算）"));
        } else if (id === "budget") {
          lines.push(...budgetHead());
          lines.push(...listLines(w));
          lines.push(footerLine("↑↓ 选择 · Enter 执行 · ←→ 翻页 · Esc 关闭"));
        } else if (id === "settings") {
          lines.push(...settingsHead());
          lines.push(...listLines(w));
          lines.push(footerLine("↑↓ 选择 · Enter 执行 · ←→ 翻页 · Esc 关闭"));
        } else {
          // pricing（rows/rowMenu/presets/presetMenu 共享正文结构）
          lines.push(...pricingHead());
          if (currentList) {
            lines.push(...listLines(w));
          } else if (pricingView === "presets") {
            // 空预设列表：仅返回提示（Esc 由 handleInput 兜底回行菜单）
            lines.push(footerLine("Esc 返回行菜单 · ←→ 翻页"));
          } else {
            lines.push(footerLine("↑↓ 选择 · Enter 进入/执行 · Esc 逐级返回 · ←→ 翻页"));
          }
        }
      }
      lines.push(theme.fg("accent", "─".repeat(Math.max(1, w))));
      return fit(lines, w);
    }

    /** 当前 SelectList 渲染行（无列表 → 空） */
    function listLines(w: number): string[] {
      if (!currentList) return [];
      return currentList.render(w);
    }

    // ── 键盘输入 ────────────────────────────────────────────────
    function handleInput(data: string): void {
      const isLeft = kb.matches(data, "tui.editor.cursorLeft");
      const isRight = kb.matches(data, "tui.editor.cursorRight");
      const isCancel = kb.matches(data, "tui.select.cancel");
      const isEnter = kb.matches(data, "tui.select.confirm");

      // 1) 录入态：字符/退格/ctrl+u/Enter/Esc
      if (input) {
        handleInputCtl(data, isEnter, isCancel);
        tui.requestRender();
        return;
      }
      // 2) 二次确认态
      if (confirm) {
        if (isEnter) {
          const c = confirm;
          confirm = null;
          c.onOk();
        } else if (isCancel) {
          confirm = null;
        }
        tui.requestRender();
        return;
      }

      // 3) ←/→ 翻页：pricing 嵌套子视图不翻页（先 Esc 逐级返回）
      const inPricingSub = PAGES[pageIdx].id === "pricing" && pricingView !== "rows";
      if (!inPricingSub) {
        if (isLeft && pageIdx > 0) {
          pageIdx -= 1;
          enterPage();
          tui.requestRender();
          return;
        }
        if (isRight && pageIdx < PAGES.length - 1) {
          pageIdx += 1;
          enterPage();
          tui.requestRender();
          return;
        }
      }

      const id = PAGES[pageIdx].id as PageId;

      // overview：Enter → 暂停当前回合（仅 streaming 中提供该行）。
      // 任务 10 暂停联动：abort 后置 paused（状态行 ⏸ 前缀与 input 闸门吞输入同步生效）；
      // 恢复 = 新会话（paused 在 session_start 重置）——跑飞刹车的硬语义（设计 §6.4）。
      if (id === "overview") {
        if (isEnter && isStreaming()) {
          ctx.abort();
          state.paused = true;
          refresh(ctx);
          setNotice("⏸ 已暂停当前回合：已产出内容保留；后续输入将被拦截，/new 开新会话恢复");
          return;
        }
        if (isCancel) done(null);
        return;
      }
      // ledger：纯展示，Esc 关闭
      if (id === "ledger") {
        if (isCancel) done(null);
        return;
      }

      // budget/settings/pricing：动作列表接管（Esc 由列表 onCancel 决定逐级/关闭）
      if (currentList) {
        currentList.handleInput(data);
        tui.requestRender();
      } else if (isCancel) {
        // 空列表兜底（如空预设列表）
        goBackFromPricingEmpty();
        tui.requestRender();
      }
    }

    /** pricing 空列表 Esc 返回上级 */
    function goBackFromPricingEmpty(): void {
      if (PAGES[pageIdx].id === "pricing" && pricingView === "presetMenu") {
        pricingView = "presets";
        presetName = null;
        rebuildListIfNeeded();
      } else if (PAGES[pageIdx].id === "pricing" && pricingView === "presets") {
        pricingView = "rowMenu";
        rebuildListIfNeeded();
      } else if (PAGES[pageIdx].id === "pricing" && pricingView === "rowMenu") {
        pricingView = "rows";
        pricingRowKey = null;
        presetName = null;
        rebuildListIfNeeded();
      } else {
        done(null);
      }
    }

    /** 录入态键处理：可打印字符（含中文单字）追加 / 退格 / ctrl+u 清空 */
    function handleInputCtl(data: string, isEnter: boolean, isCancel: boolean): void {
      const ctl = input;
      if (!ctl) return;
      if (isEnter) {
        ctl.onSubmit(ctl.buffer);
        return;
      }
      if (isCancel) {
        ctl.onCancel();
        return;
      }
      if (kb.matches(data, "tui.editor.deleteCharBackward")) {
        ctl.buffer = ctl.buffer.slice(0, -1);
        return;
      }
      if (kb.matches(data, "tui.editor.deleteToLineStart")) {
        ctl.buffer = "";
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        ctl.buffer += data;
      }
    }

    /** 进入某页：清 notice/子视图并重建列表 */
    function enterPage(): void {
      notice = "";
      pricingView = "rows";
      pricingRowKey = null;
      presetName = null;
      currentListKey = "";
      currentList = null;
      rebuildListIfNeeded();
    }

    return {
      render: (w: number) => renderAll(Math.max(1, w)),
      invalidate: () => {
        currentList?.invalidate();
      },
      handleInput,
    };
  });
}
