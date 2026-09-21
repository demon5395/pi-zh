/**
 * Anthropic 计价器（adapters/anthropic.ts）
 *
 * 官方定价页（https://docs.anthropic.com/en/docs/about-claude/pricing，
 * 2026-09-13 复核）按 USD/MTok 公布；currency:"usd"，
 * 记账时 × usdRate 出 ¥。四价 input/cacheWrite/cacheRead/output，无峰/谷语义
 * （hasValley:false）。
 * 执行期复核备注：页面主表列为 Model | Base input | 5m cache writes | 1h cache
 * writes | Cache hits | Output；本行 cacheWrite 采用 5m 档写入价（=1.25×input，
 * 与 M0 快照/契约四价字段一致；1h 档 =2×input 为独立 TTL 档，不在四价契约内）。
 * Opus 4 / 4.1 / Sonnet 4 / Haiku 3.5 页面已标注 retired（仅 Bedrock/GCloud 保留），
 * 不单列行；裸 id claude-opus-4 为 pi 现行 Opus 4 系别名，聚合入 opus-4-x 行。
 */
import type { Family, Forecast, ForecastInput, ModelAdapter, ParamSchema, ParamValue, RowSpec, UsageLike } from "./types";

const META = { _meta: { source: "https://docs.anthropic.com/en/docs/about-claude/pricing", verifiedAt: "2026-09-13" } };

const FAMILY: Family = "anthropic";
const PROVIDER = "anthropic";

const SCHEMA: ParamSchema = {
  input: { kind: "number", label: "输入价（cache miss）", unit: "USD/M", min: 0 },
  cacheWrite: { kind: "number", label: "缓存写入价（5m 档）", unit: "USD/M", min: 0 },
  cacheRead: { kind: "number", label: "缓存命中价", unit: "USD/M", min: 0 },
  output: { kind: "number", label: "输出价", unit: "USD/M", min: 0 },
};

type Prices = { input: number; cacheWrite: number; cacheRead: number; output: number };

function makeRow(key: string, prefixes: string[], price: Prices): RowSpec {
  const defaults: Record<string, ParamValue> = { ...price, ...META };
  return {
    key,
    provider: PROVIDER,
    prefixes,
    family: FAMILY,
    currency: "usd",
    cacheable: true,
    schema: SCHEMA,
    defaults,
    build(params: Record<string, ParamValue>, usdRate: number): ModelAdapter {
      /** 有效单价：¥/token（无谷时，P = USD/M 默认价 ×usdRate ÷1e6） */
      const p = (cls: "in" | "write" | "read" | "out"): number => {
        const usdPerM = params[cls === "in" ? "input" : cls === "write" ? "cacheWrite" : cls === "read" ? "cacheRead" : "output"] as number;
        return (usdPerM * usdRate) / 1e6;
      };
      const cost = (u: UsageLike): number | null =>
        u.input * p("in") + u.cacheRead * p("read") + u.cacheWrite * p("write") + u.output * p("out");
      const forecast = (i: ForecastInput): Forecast => {
        const inP = p("in"), writeP = p("write"), readP = p("read"), outP = p("out");
        return {
          hot: i.q * (i.hitRate * readP + (1 - i.hitRate) * writeP),
          cold: i.q * writeP,
          fresh: i.sys * inP + i.out * outP,
        };
      };
      return {
        key,
        family: FAMILY,
        currency: "usd",
        cacheable: true,
        params,
        cost,
        forecast,
        hasValley: false,
      };
    },
  };
}

/**
 * 五条行（官方 USD/MTok，数值与任务头 M0 表一致）：
 * - opus-4-x 覆盖 4-5..4-8（页面同价 $5/$6.25/$0.50/$25）；prefixes 中保留裸
 *   claude-opus-4 —— pi 侧现行 Opus 4 系 id 常不带小版本后缀（如 claude-opus-4-20250101
 *   归一化后即 claude-opus-4），需命中本行而非落空。行内长前缀（4-5..4-8）优先于该
 *   裸前缀（registry.matchRow 按前缀长度取最长），不影响带小版本号的模型判定。
 * - 2026-09-13 复核：五行价格均未变；新增 Fable 5 / Fable 5.1 两行（pi-ai 目录
 *   claude-fable-5 / -5-1）——同 input/write/output，仅缓存命中价不同（5.1=$0.25、5=$1）。
 */
export const ANTHROPIC_ROWS: RowSpec[] = [
  makeRow("anthropic/claude-opus-5", ["claude-opus-5"], { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }),
  makeRow(
    "anthropic/claude-opus-4-x",
    ["claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-4"],
    { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  ),
  makeRow("anthropic/claude-sonnet-5", ["claude-sonnet-5"], { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }),
  makeRow(
    "anthropic/claude-sonnet-4-x",
    ["claude-sonnet-4-5", "claude-sonnet-4-6"],
    { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  ),
  makeRow("anthropic/claude-haiku-4-5", ["claude-haiku-4-5"], { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }),
  makeRow("anthropic/claude-fable-5-1", ["claude-fable-5-1"], { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 }),
  makeRow("anthropic/claude-fable-5", ["claude-fable-5"], { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 }),
];
