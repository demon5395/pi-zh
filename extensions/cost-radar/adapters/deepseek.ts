/**
 * DeepSeek 计价器（adapters/deepseek.ts）
 *
 * 官方定价页（中文 https://api-docs.deepseek.com/zh-cn/quick_start/pricing，
 * 2026-09-15 复核）按 ¥/1M 公布；currency:"cny"，记账时 usdRate 不参与（registry
 * 对 CNY 行传 usdRate=1）。英文页同价按 USD 公布（flash 峰值 $0.30/M、pro $1.32/M）——
 * 本行取中文页人民币价直读（flash ¥2.0 / pro ¥9.0），与官方中国站账单逐位一致；
 * 旧口径「USD × usdRate(默认 7.2)」会与官方 CNY 价出现系统性偏差（如 $0.30×7.2=¥2.16 vs ¥2.0）。
 * 2026-09-15 复核：**两行价格与 2026-09-13 完全一致**（未再变动），仅官方口径更新两条——
 * (a) flash 官方 id 为 deepseek-flash、版本 DeepSeek-V4.1-Flash；旧名 deepseek-v4-flash 与
 *     deepseek-v4-flash-vision-exp **对应模型已下线**（仍可调用，请求由 V4.1-Flash 承接、按 Flash
 *     价计费），故 vision-exp 独立行已删除（原价即与 flash 同价，删除无金额影响），
 *     deepseek-v4-flash 保留为主 key 以对齐 pi-ai 目录，deepseek-flash 保留为别名；
 * (b) 官方新增脚注：2026-09-14 后继续提供 V4 Pro API，计费方式不变（pro 行无改动）。
 * 峰值时段：UTC 周一至周五 01:00-04:00 与 06:00-10:00（[start,end)）；其余=谷时，
 * 官方 off-peak = peak 半价 —— 全部三档（input miss/hit、output）×offPeakFactor。
 * 行内谷时 = 不在峰值窗（hasValley:true、inValley 语义）。
 */
import type { Family, Forecast, ForecastInput, ModelAdapter, ParamSchema, ParamValue, RowSpec, UsageLike } from "./types";
import { isInTimeWindow } from "./types";

const META = { _meta: { source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", verifiedAt: "2026-09-15" } };
const PEAK_WINDOWS: { start: string; end: string }[] = [
  { start: "01:00", end: "04:00" },
  { start: "06:00", end: "10:00" },
];

const FAMILY: Family = "deepseek";
const PROVIDER = "deepseek";

const SCHEMA: ParamSchema = {
  inputMiss: { kind: "number", label: "峰值输入价（cache miss）", unit: "¥/M", min: 0 },
  inputHit: { kind: "number", label: "峰值输入价（cache hit）", unit: "¥/M", min: 0 },
  output: { kind: "number", label: "峰值输出价", unit: "¥/M", min: 0 },
  offPeakFactor: { kind: "number", label: "谷时折扣系数", min: 0, max: 1 },
  peakWindows: { kind: "windowList", label: "峰值时段（UTC）", weekdaysLabel: "仅 UTC 工作日（周一至周五）" },
};

type PeakPrices = { inputMiss: number; inputHit: number; output: number };

function makeRow(key: string, price: PeakPrices, aliases: string[] = []): RowSpec {
  const modelId = key.slice(`${PROVIDER}/`.length);
  const defaults: Record<string, ParamValue> = {
    inputMiss: price.inputMiss,
    inputHit: price.inputHit,
    output: price.output,
    offPeakFactor: 0.5,
    peakWindows: PEAK_WINDOWS,
    zone: "utc",
    weekdaysOnly: true,
    ...META,
  };
  return {
    key,
    provider: PROVIDER,
    prefixes: [modelId, ...aliases],
    family: FAMILY,
    currency: "cny",
    cacheable: true,
    schema: SCHEMA,
    defaults,
    build(params: Record<string, ParamValue>, _usdRate: number): ModelAdapter {
      const peakWindows = params.peakWindows as { start: string; end: string }[];
      const offPeakFactor = params.offPeakFactor as number;
      const weekdaysOnly = params.weekdaysOnly === true;
      const inPeak = (ts: number) => isInTimeWindow(ts, peakWindows, "utc", weekdaysOnly);
      /** 有效单价：¥/token（CNY 行：¥/M ÷1e6，usdRate 不参与；谷时 ×offPeakFactor） */
      const p = (cls: "miss" | "hit" | "out", ts: number): number => {
        const yuanPerM = params[cls === "miss" ? "inputMiss" : cls === "hit" ? "inputHit" : "output"] as number;
        const yPerToken = yuanPerM / 1e6;
        return inPeak(ts) ? yPerToken : yPerToken * offPeakFactor;
      };
      const cost = (u: UsageLike, ts: number): number | null =>
        u.input * p("miss", ts) + u.cacheRead * p("hit", ts) + u.output * p("out", ts);
      const forecast = (i: ForecastInput, ts: number): Forecast => {
        const miss = p("miss", ts), hit = p("hit", ts), out = p("out", ts);
        return {
          hot: i.q * (i.hitRate * hit + (1 - i.hitRate) * miss),
          cold: i.q * miss,
          fresh: i.sys * miss + i.out * out,
        };
      };
      return {
        key,
        family: FAMILY,
        currency: "cny",
        cacheable: true,
        params,
        cost,
        forecast,
        hasValley: true,
        inValley: (ts: number) => !inPeak(ts),
      };
    },
  };
}

/**
 * 两行：flash / pro，官方中文页峰值人民币价（¥/M，2026-09-15 复核，与 09-13 同价）——
 * flash 2.0/0.04/8.0、pro 9.0/0.30/27.0（miss/hit/output）。
 * 别名：官方定价页现役 id 为 deepseek-flash（pro 仍为 deepseek-v4-pro），而 pi-ai 目录为
 * deepseek-v4-flash —— 两者均收入 flash 行 prefixes，避免官方 id 落空显示「未收录」。
 * 原 flash-vision-exp 行已删除：官方该模型名 2026-09 起下线、由 V4.1-Flash 承接（同 Flash 价），
 * 且 pi-ai 目录未收录该 id，独立行既无价差意义也无必要：两个已下线 id 因前缀匹配自然回落到
 * flash 行（价格本就相同）。
 */
export const DEEPSEEK_ROWS: RowSpec[] = [
  makeRow("deepseek/deepseek-v4-flash", { inputMiss: 2.0, inputHit: 0.04, output: 8.0 }, ["deepseek-flash"]),
  makeRow("deepseek/deepseek-v4-pro", { inputMiss: 9.0, inputHit: 0.30, output: 27.0 }),
];
