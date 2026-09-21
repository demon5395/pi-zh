/**
 * codex-safe 静态数据（纯数据，不 import 任何模块）。
 *
 * 哨兵域名选型：与 Codex 实际调用的域名同域，因此共享同一套 Clash 规则；
 * 探针路径 `/cdn-cgi/trace` 由 Cloudflare 提供，返回 `ip=`（出口 IP）与 `loc=`（地区码）。
 */

/** 内置 Codex provider 的 id（任务 8 会用 `ctx.model.provider` 实测核对） */
export const CODEX_PROVIDER_ID = "openai-codex";

/** Cloudflare trace 端点路径 */
export const TRACE_PATH = "/cdn-cgi/trace";

/** 哨兵域名默认值 */
export const DEFAULT_SENTINELS: readonly string[] = [
  "auth.openai.com",
  "chatgpt.com",
  "api.openai.com",
];

/**
 * 严格地区白名单：只含设计时**确信**受 OpenAI 支持的地区。
 * 不含任何猜测条目（草稿里的 TW 因无法确认已移除）；`["*"]` = 跳过地区校验（不推荐，会放宽而非收紧）。
 */
export const DEFAULT_ALLOWED_REGIONS: readonly string[] = [
  "US", "CA", "GB", "DE", "NL", "FR", "JP", "SG", "KR", "AU",
];
