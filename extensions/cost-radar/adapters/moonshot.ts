/**
 * Moonshot（Kimi）计价器（adapters/moonshot.ts）
 *
 * 官方定价核对：2026-09-13 复核。定价页已迁至 platform.kimi.com（Mintlify 静态
 * markdown，可核对）：
 *   - https://platform.kimi.com/docs/pricing/chat
 * 旧 platform.moonshot.cn/docs/pricing/chat-{k3,k27-code,k26} 链接失效。四项价格未变。
 * 官方按 ¥/1M token 公布；currency:"cny"，build 不乘 usdRate（registry 对 CNY 行传
 * usdRate=1）。字段形态 = 输入（缓存命中）/ 输入（缓存未命中）/ 输出，无缓存写费
 * （自动上下文缓存，无 write 档）——防御：usage.cacheWrite>0 时按未命中输入价计价。
 * 无峰/谷语义（hasValley:false）。
 *
 * ⚠️ provider 绑定：pi-ai 目录中 Moonshot 国内官方端点（api.moonshot.cn/v1）的
 * provider 名为 "moonshotai-cn"（本环境 deepseek/anthropic/openai 行均按 pi-ai 目录
 * provider 名绑定，此处同理）。现役 kimi-k3/k2.7/k2.6 尚未进入该目录快照（目录仍为
 * 已下架 k2-* 旧型号）→ 现行 k2 会话走「未收录」不计金额（与页面不再列出旧价一致）；
 * 目录刷新加入 k3 系后本行自动命中。国际版（api.moonshot.ai，USD 价）与 kimi-coding
 * 通道（anthropic 格式）不在本 CN 页面范围内，未收录。
 */
import type { Family, Forecast, ForecastInput, ModelAdapter, ParamSchema, ParamValue, RowSpec, UsageLike } from "./types";

const FAMILY: Family = "moonshot";
const PROVIDER = "moonshotai-cn";

const SCHEMA: ParamSchema = {
  inputMiss: { kind: "number", label: "输入价（缓存未命中）", unit: "¥/M", min: 0 },
  inputHit: { kind: "number", label: "输入价（缓存命中）", unit: "¥/M", min: 0 },
  output: { kind: "number", label: "输出价", unit: "¥/M", min: 0 },
};

type Prices = { inputMiss: number; inputHit: number; output: number };

function makeRow(key: string, source: string, price: Prices): RowSpec {
  const defaults: Record<string, ParamValue> = {
    ...price,
    _meta: { source, verifiedAt: "2026-09-13" },
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
      /** 有效单价：¥/token（CNY 行：¥/M ÷1e6，usdRate 不参与） */
      const p = (cls: "miss" | "hit" | "out"): number => {
        const yuanPerM = params[cls === "miss" ? "inputMiss" : cls === "hit" ? "inputHit" : "output"] as number;
        return yuanPerM / 1e6;
      };
      const cost = (u: UsageLike): number | null =>
        u.input * p("miss") +
        u.cacheRead * p("hit") +
        (u.cacheWrite > 0 ? u.cacheWrite * p("miss") : 0) + // 无写费档，防御按未命中输入计
        u.output * p("out");
      const forecast = (i: ForecastInput): Forecast => {
        const miss = p("miss"), hit = p("hit"), out = p("out");
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
        hasValley: false,
      };
    },
  };
}

/**
 * 四行（官方 ¥/1M，2026-09-13 页面提取，四项价格未变）：kimi-k3 / kimi-k2.7-code /
 * kimi-k2.7-code-highspeed / kimi-k2.6。表格列为 输入价格（缓存命中）| 输入价格
 * （缓存未命中）| 输出价格；默认自动上下文缓存，无写费。
 */
export const MOONSHOT_ROWS: RowSpec[] = [
  makeRow("moonshotai-cn/kimi-k3", "https://platform.kimi.com/docs/pricing/chat", { inputMiss: 20, inputHit: 2, output: 100 }),
  makeRow("moonshotai-cn/kimi-k2.7-code", "https://platform.kimi.com/docs/pricing/chat", { inputMiss: 6.5, inputHit: 1.3, output: 27 }),
  makeRow("moonshotai-cn/kimi-k2.7-code-highspeed", "https://platform.kimi.com/docs/pricing/chat", { inputMiss: 13, inputHit: 2.6, output: 54 }),
  makeRow("moonshotai-cn/kimi-k2.6", "https://platform.kimi.com/docs/pricing/chat", { inputMiss: 6.5, inputHit: 1.1, output: 27 }),
];
