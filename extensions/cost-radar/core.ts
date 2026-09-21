/**
 * cost-radar 纯逻辑层（core.ts）
 *
 * 无 pi 依赖、无 adapters/index/config 依赖（层依赖规则：core 只经注入的
 * costOf/coveredOf 与外部计价解耦；usage 形状为本地结构型，与 adapters/UsageLike
 * 靠结构兼容）。任务 5：账本聚合 + 缓存 TTL 状态机 + 占比辅助；
 * 任务 6：输入量推导 / 预算状态 / 格式化 / 状态行拼装 / 新会话徽标。
 */

/** token 四维合计（与 adapters/UsageLike 同形；core 侧记账单位） */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 账本条目：modelKey=null 表示无归属（工具/无 model 条目），token 计入但不计金额 */
export interface LedgerRow {
  modelKey: string | null;
  usage: UsageTotals;
  tsMs: number;
  /** 来源为 subagent 工具结果（归账展示用，不改变金额口径） */
  subagent?: boolean;
}

export interface SpendResult {
  /** 已归属且可计模型合计（¥）；costOf 返回 null 的已收录条目按 0 计 */
  spendYuan: number;
  /** 已收录模型分组：金额与 token（未收录模型不建条目） */
  perModel: Record<string, { yuan: number; tokens: UsageTotals }>;
  /** modelKey==null 条目的 token（不计金额） */
  unallocatedTokens: UsageTotals;
  /** 全部条目 token（含无归属与未收录） */
  rawTokens: UsageTotals;
  /** 有归属条目是否全部已收录（false → 状态行「部分未收录」标注） */
  allCovered: boolean;
  /** 子代理来源统计：次数 / 可计金额 / 未收录条数（面板汇总行用） */
  subagent: { count: number; yuan: number; unpriced: number };
}

const ZERO: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function addTotals(a: UsageTotals, b: UsageTotals): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
}

/**
 * 账本聚合：遍历 rows——
 * - modelKey===null → unallocatedTokens += usage（rawTokens 照计，不计金额）；
 * - 未收录（coveredOf=false）→ 仅 rawTokens + allCovered=false，不建 perModel 条目；
 * - 已收录 → costOf(key, usage, tsMs) 得金额（null → 0），perModel[key] 累计 tokens/yuan。
 */
export function aggregateLedger(
  rows: LedgerRow[],
  costOf: (key: string, u: UsageTotals, tsMs: number) => number | null,
  coveredOf: (key: string) => boolean,
): SpendResult {
  const perModel = Object.create(null) as SpendResult["perModel"];
  const unallocatedTokens = { ...ZERO };
  const rawTokens = { ...ZERO };
  const subagent = { count: 0, yuan: 0, unpriced: 0 };
  let spendYuan = 0;
  let allCovered = true;

  for (const row of rows) {
    addTotals(rawTokens, row.usage);
    if (row.modelKey === null) {
      addTotals(unallocatedTokens, row.usage);
      continue;
    }
    if (!coveredOf(row.modelKey)) {
      allCovered = false;
      if (row.subagent) {
        subagent.count++;
        subagent.unpriced++;
      }
      continue;
    }
    let entry = perModel[row.modelKey];
    if (!entry) {
      entry = { yuan: 0, tokens: { ...ZERO } };
      perModel[row.modelKey] = entry;
    }
    addTotals(entry.tokens, row.usage);
    const amount = costOf(row.modelKey, row.usage, row.tsMs);
    const yuan = amount == null ? 0 : amount;
    entry.yuan += yuan;
    spendYuan += yuan;
    if (row.subagent) {
      subagent.count++;
      subagent.yuan += yuan;
    }
  }

  return { spendYuan, perModel, unallocatedTokens, rawTokens, allCovered, subagent };
}

export type CachePhase = "unknown" | "rebuilding" | "warm" | "expired";

export interface CacheStateIn {
  lastInput: number;
  lastCacheRead: number;
  lastCacheWrite: number;
  lastActivityMs: number;
  nowMs: number;
  /** 缓存 TTL（ms），默认 5min */
  ttlMs?: number;
}

export interface CacheStateOut {
  phase: CachePhase;
  /** 剩余秒数；仅 warm 有值，其余 null */
  secondsLeft: number | null;
}

const DEFAULT_TTL_MS = 5 * 60_000;

/** writeShare = cacheWrite/(input+cacheRead+cacheWrite)；分母全 0 → 0 */
export function writeShare(u: UsageTotals): number {
  const denom = u.input + u.cacheRead + u.cacheWrite;
  return denom === 0 ? 0 : u.cacheWrite / denom;
}

/** hitRateOf = cacheRead/(input+cacheRead+cacheWrite)；分母全 0 → 0 */
export function hitRateOf(u: UsageTotals): number {
  const denom = u.input + u.cacheRead + u.cacheWrite;
  return denom === 0 ? 0 : u.cacheRead / denom;
}

/**
 * 缓存 TTL 状态机（判定顺序权威）：
 * 无 usage（三维全 0）→ unknown；idle≥ttl → expired（含重建后过期）；
 * writeShare>0.5 → rebuilding；否则 warm（命中率低也按 warm 计时）。
 * secondsLeft 仅 warm 有值：ceil((ttl−idle)/1000)。
 */
export function cacheState(i: CacheStateIn): CacheStateOut {
  const ttl = i.ttlMs ?? DEFAULT_TTL_MS;
  const idle = Math.max(0, i.nowMs - i.lastActivityMs);
  if (i.lastInput === 0 && i.lastCacheRead === 0 && i.lastCacheWrite === 0) {
    return { phase: "unknown", secondsLeft: null };
  }
  if (idle >= ttl) {
    return { phase: "expired", secondsLeft: null };
  }
  if (writeShare({ input: i.lastInput, cacheRead: i.lastCacheRead, cacheWrite: i.lastCacheWrite, output: 0 }) > 0.5) {
    return { phase: "rebuilding", secondsLeft: null };
  }
  return { phase: "warm", secondsLeft: Math.ceil((ttl - idle) / 1000) };
}

// ─── 任务 6：输入量推导 / 预算状态 / 格式化 / 状态行拼装 / 新会话徽标 ───

/** 下一轮输入量：Q=最近 prompt 合计、O=输出均值、sys=Sys+U 估算 token */
export interface NextTurn {
  /** 下一轮输入量（最近一次 assistant usage prompt tokens 合计） */
  q: number;
  /** 输出均值（outs 空 → 0） */
  out: number;
  /** Sys+U 估算 token：round(systemChars/4 + lastUserChars/4) */
  sys: number;
}

/**
 * 输入量推导：Q=lastPromptTokens ?? 0；O=outs 非空均值（空 → 0）；
 * sys=Math.round(systemChars/4 + lastUserChars/4)。
 */
export function deriveNextTurn(opts: {
  lastPromptTokens: number | null;
  outs: number[];
  systemChars: number;
  lastUserChars: number;
}): NextTurn {
  const q = opts.lastPromptTokens ?? 0;
  const out =
    opts.outs.length === 0
      ? 0
      : opts.outs.reduce((a, b) => a + b, 0) / opts.outs.length;
  const sys = Math.round(opts.systemChars / 4 + opts.lastUserChars / 4);
  return { q, out, sys };
}

export interface BudgetStateIn {
  defaultBudget: number | null;
  /** 本会话预算（覆盖默认，内存态；/new 回落）；null = 未设 */
  sessionBudget: number | null;
  spendYuan: number;
}

export interface BudgetStateOut {
  /** 生效额度已设（limit!=null，含 0） */
  enabled: boolean;
  /** 生效额度（¥）；未设 → 0 */
  limitYuan: number;
  /** 已用百分比；未设 → 0 */
  pct: number;
  /** 色阶：pct≥100→over、≥80→warn、否则 ok */
  tier: "ok" | "warn" | "over";
}

/**
 * 预算状态：limit = sessionBudget ?? defaultBudget；enabled = limit!=null（含 0）；
 * pct = Math.round(spend/limit*100)（limit 0 → 100）；未设时返回全 0/ok 自洽值。
 */
export function budgetState(i: BudgetStateIn): BudgetStateOut {
  const limit = i.sessionBudget ?? i.defaultBudget;
  if (limit == null) {
    return { enabled: false, limitYuan: 0, pct: 0, tier: "ok" };
  }
  const pct = limit === 0 ? 100 : Math.round((i.spendYuan / limit) * 100);
  const tier = pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok";
  return { enabled: true, limitYuan: limit, pct, tier };
}

/**
 * ¥ 格式化：0 → "0"；0<y<1 → 3 位小数（保留 3 位不删尾零）；否则 2 位。
 */
export function fmtYuan(y: number): string {
  if (y === 0) return "0";
  if (y > 0 && y < 1) return y.toFixed(3);
  return y.toFixed(2);
}

/**
 * ¥ 金额严格解析（任务 10 优化 🟡3；/cost budget CLI、闸门本会话预算、面板预算读取共用语义）：
 * 仅接受普通十进制小数（整数或 整数.小数，小数部分至少一位）、Number 有限、>0；
 * 拒绝：0/负数、NaN/Infinity、hex(0x)/二进制(0b)/八进制(0o)、指数与科学计数(e/E)、
 * 空串、任何空白（含首尾与内部）与其余非纯数字字符——旧 Number() 路径会把
 * "0x10"(=16)/"1e5"(=100000)/"0b101"(=5) 意外当作合法金额。
 *
 * 契约：入参为「纯数字字符串」；¥/￥/元/千分逗号等展示符号的剥离是调用方职责
 * （CLI 在传入前完成，见 index.parseBudgetAmount）。面板预算 GUI 的 min 0.01 下限
 * 属 UI 层约束叠加，本函数不感知（>0 即合法，0.005 等小额由业务侧自行解释）。
 * 合法值边界："10"→10、"0.5"→0.5、"0.01"→0.01；"0"→null（>0 校验）。
 */
export function parseYuanAmount(s: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * token 缩写：≥1e6 → "x.xM"、≥1e3 → "x.xk"、否则整数（对 0/负/小数健壮）。
 */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 秒 → "m:ss"（秒 padStart 2）：272 → "4:32" */
export function fmtClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 新会话建议徽标：show = ctxPercent>85 || (cold>fresh×2 && cold>minColdYuan)；
 * savePerRoundYuan = cold−fresh。
 *
 * 注意：契约以可执行测试为准——参数顺序为 (ctxPercent, fresh, cold)，
 * fresh=新会话档、cold=续冷档（计划文本已同步修正 a53f236）；
 * 调用方（任务 8/9）务必按此顺序传参。
 */
export function suggestNewSession(
  ctxPercent: number,
  fresh: number,
  cold: number,
  minColdYuan = 0.05,
): { show: boolean; savePerRoundYuan: number } {
  const show = ctxPercent > 85 || (cold > fresh * 2 && cold > minColdYuan);
  // 规整到 1e-6：消浮点噪声（0.02−0.2 → -0.18000000000000002），¥ 精度内无害
  const save = Math.round((cold - fresh) * 1e6) / 1e6;
  return { show, savePerRoundYuan: save };
}

/**
 * 状态行拼装：parts join(" ")，超长（>cap，默认 45）从尾部依次移除段直到 ≤cap 或
 * 仅剩首段（首段不裁剪——真实首段 spend 长度有界，超长不可达）；保头部 spend。
 * 空 parts 返回 ""。不修改入参数组。
 */
export function assembleStatusLine(parts: string[], cap = 45): string {
  const list = parts.filter((p) => p !== "");
  while (list.length > 1 && list.join(" ").length > cap) {
    list.pop();
  }
  return list.join(" ");
}
