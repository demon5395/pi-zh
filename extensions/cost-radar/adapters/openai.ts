/**
 * OpenAI 计价器（adapters/openai.ts）
 *
 * 官方定价页 https://platform.openai.com/docs/pricing（2026-09-13 复核；
 * openai.com/api/pricing 为 JS 渲染且 403，platform docs 页内嵌价格表可解析）。
 * 官方按 USD/MTok 公布；currency:"usd"，记账 × usdRate 出 ¥。
 * 字段形态：旧 4.x 行为三价 input/cacheHit/output（缓存命中为自动折扣价，无写费档）；
 * 2026 新旗舰（gpt-6-astra / gpt-5.6-*）官方新增独立 cache writes 档（=1.25×input），
 * 故 schema 可选含 cacheWrite——旧行无写价字段时防御按 input 价计，不静默丢弃。
 * 无峰/谷语义（hasValley:false）。
 *
 * 档位口径限制：官方同一模型还分短/长上下文档（prompts >272K input tokens
 * 整单 2×input/cache、1.5×output）与 Batch/Flex（≈5 折）、Fast（2×）档。pi-ai `Usage` 不含
 * 上下文长度与 `service_tier`（仅 input/output/cacheRead/cacheWrite/reasoning/totalTokens，
 * 无 contextTokens/service_tier 字段），无法按请求的档位计价。以下 golden 一律取官方
 * **Standard 短上下文** 档：长上下文与 Fast 档会**低估**（约 2× 输入、1.5× 输出 / 2×），
 * Batch·Flex 档会**高估**（约 2×）。待 pi-ai `Usage` 暴露档位信息后再按档计价。
 */
import type { Family, Forecast, ForecastInput, ModelAdapter, ParamSchema, ParamValue, RowSpec, UsageLike } from "./types";

const META = { _meta: { source: "https://platform.openai.com/docs/pricing", verifiedAt: "2026-09-13" } };

const FAMILY: Family = "openai";
const PROVIDER = "openai";

/** 有写价档时追加 cacheWrite 字段；旧 4.x 行保持三价 schema */
function schemaFor(hasWrite: boolean): ParamSchema {
  return {
    input: { kind: "number", label: "输入价（cache miss）", unit: "USD/M", min: 0 },
    ...(hasWrite ? { cacheWrite: { kind: "number" as const, label: "缓存写入价", unit: "USD/M", min: 0 } } : {}),
    cacheHit: { kind: "number", label: "缓存命中价（自动折扣）", unit: "USD/M", min: 0 },
    output: { kind: "number", label: "输出价", unit: "USD/M", min: 0 },
  };
}

type Prices = { input: number; cacheHit: number; output: number; cacheWrite?: number };

function makeRow(key: string, prefixes: string[], price: Prices): RowSpec {
  const defaults: Record<string, ParamValue> = { ...price, ...META };
  return {
    key,
    provider: PROVIDER,
    prefixes,
    family: FAMILY,
    currency: "usd",
    cacheable: true,
    schema: schemaFor(price.cacheWrite !== undefined),
    defaults,
    build(params: Record<string, ParamValue>, usdRate: number): ModelAdapter {
      /** 有效单价：¥/token（无谷时，P = USD/M 默认价 ×usdRate ÷1e6） */
      const p = (cls: "in" | "write" | "hit" | "out"): number => {
        const usdPerM = params[cls === "in" ? "input" : cls === "write" ? "cacheWrite" : cls === "hit" ? "cacheHit" : "output"] as number;
        return (usdPerM * usdRate) / 1e6;
      };
      /** 写价：有 cacheWrite 字段则读官方写价，否则（旧 4.x 行）防御按 input 计 */
      const writeP = (): number => (params.cacheWrite === undefined ? p("in") : p("write"));
      const cost = (u: UsageLike): number | null =>
        u.input * p("in") +
        u.cacheRead * p("hit") +
        (u.cacheWrite > 0 ? u.cacheWrite * writeP() : 0) +
        u.output * p("out");
      const forecast = (i: ForecastInput): Forecast => {
        const inP = p("in"), hitP = p("hit"), outP = p("out"), wp = writeP();
        return {
          hot: i.q * (i.hitRate * hitP + (1 - i.hitRate) * wp),
          cold: i.q * wp,
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
 * 二十五条（官方 USD/MTok，2026-09-13 复核；与 pi-ai 目录 cost 一致）：
 * - 旧六行 gpt-4o / gpt-4o-mini / gpt-4o-2024-05-13 / gpt-4.1 / 4.1-mini / 4.1-nano：价格未变，
 *   无写费档。prefixes 保留原 id 带点形态，matchRow 按 normalizeModelId 归一后长前缀优先匹配
 *   （gpt-4o-mini、gpt-4o-2024-05-13 为独立行且长前缀恒胜，不会被 "gpt-4o" 短前缀吞并；
 *   gpt-4o-2024-08-06 / 11-20 与基础 gpt-4o 同价，经短前缀命中即为正确）。
 * - 中代十五行 gpt-5 / 5-mini / 5-nano / 5-pro / 5.1 / 5.2 / 5.2-pro / 5.3-chat-latest /
 *   5.3-codex（含 spark）/ 5.4 / 5.4-mini / 5.4-nano / 5.4-pro / 5.5 / 5.5-pro：无写费档
 *   （pro 系 cacheRead=0）；gpt-5 用宽前缀覆 dated 快照，chat-latest 同价挂靠。
 * - 新旗舰四行 gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna：官方新增独立
 *   cache writes 档（=1.25×input）。
 * - 档位口径：prompts >272K input tokens 整单按 2×input/cache、1.5×output 计（pi-ai
 *   cost.tiers.inputTokensAbove=272000）；usage 不含上下文长度 / service_tier，无法按长上下文、
 *   Batch·Flex、Fast 档计价，故统一取 **Standard 短上下文** 档 golden（低估长上下文与 Fast、
 *   高估 Batch·Flex；详见文件头「档位口径限制」）。
 */
export const OPENAI_ROWS: RowSpec[] = [
  makeRow("openai/gpt-4o", ["gpt-4o"], { input: 2.5, cacheHit: 1.25, output: 10 }),
  makeRow("openai/gpt-4o-mini", ["gpt-4o-mini"], { input: 0.15, cacheHit: 0.075, output: 0.6 }),
  makeRow("openai/gpt-4o-2024-05-13", ["gpt-4o-2024-05-13"], { input: 5, cacheHit: 0, output: 15 }),
  makeRow("openai/gpt-4.1", ["gpt-4.1"], { input: 2, cacheHit: 0.5, output: 8 }),
  makeRow("openai/gpt-4.1-mini", ["gpt-4.1-mini"], { input: 0.4, cacheHit: 0.1, output: 1.6 }),
  makeRow("openai/gpt-4.1-nano", ["gpt-4.1-nano"], { input: 0.1, cacheHit: 0.025, output: 0.4 }),
  // 中代 gpt-5.x（无写费档；pro 系 cacheRead=0）
  makeRow("openai/gpt-5", ["gpt-5", "gpt-5-chat-latest"], { input: 1.25, cacheHit: 0.125, output: 10 }),
  makeRow("openai/gpt-5-mini", ["gpt-5-mini"], { input: 0.25, cacheHit: 0.025, output: 2 }),
  makeRow("openai/gpt-5-nano", ["gpt-5-nano"], { input: 0.05, cacheHit: 0.005, output: 0.4 }),
  makeRow("openai/gpt-5-pro", ["gpt-5-pro"], { input: 15, cacheHit: 0, output: 120 }),
  makeRow("openai/gpt-5.1", ["gpt-5.1"], { input: 1.25, cacheHit: 0.125, output: 10 }),
  makeRow("openai/gpt-5.2", ["gpt-5.2", "gpt-5.2-chat-latest"], { input: 1.75, cacheHit: 0.175, output: 14 }),
  makeRow("openai/gpt-5.2-pro", ["gpt-5.2-pro"], { input: 21, cacheHit: 0, output: 168 }),
  makeRow("openai/gpt-5.3-chat-latest", ["gpt-5.3-chat-latest"], { input: 1.75, cacheHit: 0.175, output: 14 }),
  makeRow("openai/gpt-5.3-codex", ["gpt-5.3-codex", "gpt-5.3-codex-spark"], { input: 1.75, cacheHit: 0.175, output: 14 }),
  makeRow("openai/gpt-5.4", ["gpt-5.4"], { input: 2.5, cacheHit: 0.25, output: 15 }),
  makeRow("openai/gpt-5.4-mini", ["gpt-5.4-mini"], { input: 0.75, cacheHit: 0.075, output: 4.5 }),
  makeRow("openai/gpt-5.4-nano", ["gpt-5.4-nano"], { input: 0.2, cacheHit: 0.02, output: 1.25 }),
  makeRow("openai/gpt-5.4-pro", ["gpt-5.4-pro"], { input: 30, cacheHit: 0, output: 180 }),
  makeRow("openai/gpt-5.5", ["gpt-5.5"], { input: 5, cacheHit: 0.5, output: 30 }),
  makeRow("openai/gpt-5.5-pro", ["gpt-5.5-pro"], { input: 30, cacheHit: 0, output: 180 }),
  // 新旗舰（有独立 cache writes 档）
  makeRow("openai/gpt-6-astra", ["gpt-6-astra"], { input: 10, cacheWrite: 12.5, cacheHit: 1, output: 50 }),
  makeRow("openai/gpt-5.6-sol", ["gpt-5.6-sol"], { input: 4, cacheWrite: 5, cacheHit: 0.4, output: 20 }),
  makeRow("openai/gpt-5.6-terra", ["gpt-5.6-terra"], { input: 2, cacheWrite: 2.5, cacheHit: 0.2, output: 12 }),
  makeRow("openai/gpt-5.6-luna", ["gpt-5.6-luna"], { input: 0.2, cacheWrite: 0.25, cacheHit: 0.02, output: 1.2 }),
];
