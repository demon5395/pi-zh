/**
 * 阿里云百炼 Qwen 计价器（adapters/qwen.ts）
 *
 * 官方定价核对：2026-09-13 复核（价格未变）抓取百炼「模型调用价格」文档
 * （阿里云帮助中心静态渲染，价格表直接可核对）：
 *   - https://help.aliyun.com/zh/model-studio/billing-for-model-studio
 * 官方按 ¥/每百万 token 公布；currency:"cny"，build 不乘 usdRate。
 *
 * 模型范围（页面核对选定）：qwen3.8-max（¥12/¥36）、qwen3.8-flash（¥0.8/¥2.7）——
 * 两行在页面上均为单档（0<Token≤1M）、思考/非思考同价、且北京/美国/新加坡/法兰克福/
 * 东京全地域同价，无阶梯与分档歧义，可直接适配单行 schema。qwen3.7-plus/flash 等
 * 按输入 Token 量分阶梯 + 思考模式分档（页面同表）→ 不收录（未收录路径：仅计 token）。
 *
 * 缓存语义（官方 context-cache 文档 https://help.aliyun.com/zh/model-studio/context-cache）：
 * 默认走「隐式缓存」（自动、不可关）——命中缓存部分按输入标准单价的 20% 计费，创建缓存
 * 无额外写费（按输入 100% 计，已在 usage.input 内）。显式缓存（125% 创建/10% 命中，需
 * cache_control 主动开启）非默认路径，不在本行 schema 内。防御：usage.cacheWrite>0
 * 时按输入价计价（隐式无写费档，不静默丢弃）。无峰/谷语义（hasValley:false）。
 *
 * ⚠️ provider 绑定：pi-ai 现行目录中 qwen3.8-* 仅经 qwen-token-plan(-cn/-individual)
 * 套餐通道提供（目录 cost=0，套餐内边际成本为 0）→ 现网不会命中本族 ¥ 行，套餐会话
 * 走「未收录」不计金额，不产生误计费。本族行以百炼官方按量价为 golden；待 pi-ai 增加
 * 百炼直连按量（DashScope/maas）provider 后，仅需将下方 PROVIDER 对齐该目录 provider 名
 * （真机验证项 A2）即可自动命中。
 */
import type { Family, Forecast, ForecastInput, ModelAdapter, ParamSchema, ParamValue, RowSpec, UsageLike } from "./types";

const FAMILY: Family = "qwen";
const PROVIDER = "qwen";

const SCHEMA: ParamSchema = {
  input: { kind: "number", label: "输入价（缓存未命中）", unit: "¥/M", min: 0 },
  output: { kind: "number", label: "输出价", unit: "¥/M", min: 0 },
  /** 隐式缓存命中折扣系数：官方=输入标准单价×0.2（context-cache 文档） */
  implicitHitFactor: { kind: "number", label: "隐式缓存命中折扣（×输入价）", min: 0, max: 1 },
};

type Prices = { input: number; output: number };

function makeRow(key: string, price: Prices): RowSpec {
  const defaults: Record<string, ParamValue> = {
    ...price,
    implicitHitFactor: 0.2,
    _meta: { source: "https://help.aliyun.com/zh/model-studio/billing-for-model-studio", verifiedAt: "2026-09-13" },
  };
  return {
    key,
    provider: PROVIDER,
    prefixes: [key.slice(`${PROVIDER}/`.length)],
    family: FAMILY,
    currency: "cny",
    cacheable: true,
    schema: SCHEMA,
    defaults,
    build(params: Record<string, ParamValue>, _usdRate: number): ModelAdapter {
      const hitFactor = params.implicitHitFactor as number;
      /** 有效单价：¥/token（CNY 行：¥/每百万 ÷1e6，usdRate 不参与） */
      const p = (cls: "in" | "out"): number => (params[cls === "in" ? "input" : "output"] as number) / 1e6;
      const inP = p("in"), outP = p("out"), hitP = inP * hitFactor;
      const cost = (u: UsageLike): number | null =>
        u.input * inP +
        u.cacheRead * hitP +
        (u.cacheWrite > 0 ? u.cacheWrite * inP : 0) + // 隐式缓存无写费档，防御按输入计
        u.output * outP;
      const forecast = (i: ForecastInput): Forecast => ({
        hot: i.q * (i.hitRate * hitP + (1 - i.hitRate) * inP),
        cold: i.q * inP,
        fresh: i.sys * inP + i.out * outP,
      });
      return {
        key,
        family: FAMILY,
        currency: "cny",
        cacheable: true,
        params,
        cost,
        forecast,
        hasValley: false,
      };
    },
  };
}

/** 两行（官方 ¥/每百万，2026-09-13 页面提取，价格未变；单档/思考非思考同价/全地域同价） */
export const QWEN_ROWS: RowSpec[] = [
  makeRow("qwen/qwen3.8-max", { input: 12, output: 36 }),
  makeRow("qwen/qwen3.8-flash", { input: 0.8, output: 2.7 }),
];
