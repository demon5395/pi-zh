# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/) 规范。

---

## [Unreleased]

### 新增

- `codex-safe` **Docker 容器代理支持**：新增代理解析模块，容器内检测到 `/.dockerenv` 后把配置/环境里的回环代理（`127.0.0.1` / `localhost` / `::1`）解析为运行时地址 `http://host.docker.internal:<port>`（保留协议、端口、认证与路径）；非回环地址原样返回。解析结果只用于诊断与探针，不写回 `codex-safe.json`。
- `/codex-safe doctor` / `/codex-safe proxy` **同时展示原始地址与运行时地址**：容器内改写回环代理；宿主别名 `host.docker.internal` 无法解析时给出 `extra_hosts: ["host.docker.internal:host-gateway"]` 排查提示；当前进程实际生效代理仍是容器不可达回环地址时报告「启动配置错误」，提示重启 Pi，不降级直连、不改安全判定。

### 文档

- README 新增「容器（Docker）场景」：Compose 注入 `HTTP_PROXY`/`HTTPS_PROXY` 或把 `settings.json` 的 `httpProxy` 配为 `http://host.docker.internal:<port>`，修改后需重启 Pi，以及 `host.docker.internal` 无法解析时的排查与 `extra_hosts` 示例。

### 测试

- 新增 `resolver.test.ts`，覆盖宿主/容器回环、IPv6 回环、非回环地址原样返回、协议/端口/认证/path 保留、非法 URL、宿主别名解析失败告警等用例；`index.test.ts`、`probe.test.ts` 补充容器代理诊断断言。

## [0.7.0] - 2026-09-20

### 新增

- `codex-safe` 出口守卫扩展：`/codex-safe doctor` 多哨兵域名双路探针诊断（经代理 vs 直连出口对比）；`/codex-safe proxy` 读写 pi `settings.json` 的 `httpProxy`（原子写 + 备份）；codex 模型下 input 硬闸 + 三选一二次确认 + 10s 周期复检 + `ctx.abort()`。
- pi-zh 定位由「中文配套工具集」调整为「中文用户的实用工具集」，移除「零网络」表述（codex-safe 会联网）。

### 变更

- `cost-radar` **DeepSeek 官方定价 2026-09-15 复核：两行价格与 09-13 完全一致（无变动）**，但官方口径有两处更新，同步刷新 `adapters/deepseek.ts` 头注释与 `_meta.verifiedAt`：(a) flash 官方 id 为 `deepseek-flash`、版本 **DeepSeek-V4.1-Flash**，旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` **对应模型已下线**（仍可调用，请求由 V4.1-Flash 承接、按 Flash 价计费）；(b) 官方新增脚注：**2026-09-14 后继续提供 V4 Pro API，计费方式不变**。

### 修复

- `cost-radar` **删除 DeepSeek `deepseek-v4-flash-vision-exp` 独立价格行**：该官方模型名已下线且 `pi-ai` 目录未收录，独立行既无价差也非必要——两个已下线 id 现经前缀匹配**自然回落到 flash 行**（价格本就相同，峰值 ¥2.0/¥0.04/¥8.0），金额口径不变。内置价格行由 18 条降为 17 条；`/cost` 单品页与覆盖白名单均由 `listRows()` 动态派生，无需额外改动。
- `cost-radar` **孤儿覆盖键不再静默失效**：`loadConfig` 新增可选 `rows` 白名单参数（`index` 侧传 `registry.listRows()`，不传则保持旧行为），启动时对 `priceOverrides` 中**不在内置清单**的 key 及 `userPresets` 各预设内的同类 key 各出一条聚合告警（至多列 3 个键名 + 「等 N 个」），提示 `priceOverrides` 项不会生效、预设项载入时会被过滤。此前官方下线某模型、雷达删除其价格行后，用户 config 中的旧覆盖会从此无声失效且无任何提示（如本次 DeepSeek `deepseek-v4-flash-vision-exp` 行删除，见上）。**只告警不删除**：数据保留，若该行日后回归清单覆盖自动复活。

### 测试

- `deepseek.test.ts`「收录三模型」改为「收录两模型」，并新增断言：`DEEPSEEK_ROWS` 无 `vision-exp` 行、两个已下线 id 均回落到 `deepseek/deepseek-v4-flash`。
- `config.test.ts` 新增孤儿覆盖键告警 4 例（不传 `rows` 不校验 / 顶层孤儿告警并保留数据 / 全合法无告警 / 预设内层孤儿按预设名聚合且 >3 归纳）；`index.test.ts` 新增 session_start 端到端告警断言（**删掉 `listRows()` 参数该用例即失败**，已验证）。
- `codex-safe` 新增配置读写、双路探针、判定、TTL 守卫、`pi-settings` 读写等 vitest 用例；累计 `npx vitest run` **201/201**。

## [0.6.0] - 2026-09-13

### 新增

- `cost-radar` **跨 cwd 子代理提示**：解析父会话 `subagent` 工具结果 `details.results[].cwd`，按 `cwd !== 父会话 cwd` 计数；账本页常驻提示「N 次子代理未纳入共享闸门」（跨 cwd 仍保守不误拦，`check` 返回 `limit: null`）。

### 变更

- `cost-radar` **`/reload` 额度总线自愈**：`session_start` 安装条件放宽为「无残留，或残留 `ownerSessionId === 本会话 id` 时覆盖安装」；不同会话 id 仍保留「同 cwd 先建者拥有」语义，避免旧 factory 闭包读到过期快照。

### 修复

- `cost-radar` 额度总线新增 `instanceId`，`uninstallBudget` 按实例清理，防 `session_shutdown` / `session_start` 反序时旧实例误删新 bus。
- `cost-radar` 跨 cwd 判据先 `path.resolve` 归一再比较，避免符号链接 / 相对路径等价字面量被误计。

### 文档

- `cost-radar` OpenAI 适配器头注释与 README 明示档位计价口径：golden 统一取 Standard 短档；长上下文与 Fast 档低估，Batch·Flex 档高估；修正原「Batch·Fast 同口径低估」表述。

### 测试

- `index.test.ts` 补会话生命周期与「覆盖安装后 `check()` 返回新实例实时值」断言；`rows.test.ts` 补等价字面量用例；累计 `npx vitest run` **117/117**。

## [0.5.0] - 2026-09-13

### 新增

- `cost-radar` **子代理用量归账**：父会话账本现计入 `subagent` 工具结果的子代理消耗。归账采用三重判据（`toolName==="subagent"`、`details.costContract===1`、`results` 为数组）与 usage 四维校验，只浅读 `.results[].usage/.provider/.model/.endedAt`（不深遍历 `details.messages`）；金额按 `provider/model` + usage 本地重算，`result.endedAt` 优先用于谷时取价。子代理返回后状态行 `⛽` 与预算百分比随即跳升，`/cost` 账本页新增汇总行 `子代理（N 次）¥x（M 条未收录不计）`；检测到有正用量但缺 `provider`/契约时，账本页常驻提示 `M 条缺少 provider 未计入（需升级 pi-subagent）` 并一次性 notify。
- `cost-radar` **只读共享额度总线**（`globalThis.__piCostRadarBudget`，`version: 2`）：仅在 TUI 父会话发布、`session_shutdown` 由 owner 清理，提供纯读的 `check(cwd)`（生效额度 + 父 spend 快照）与纯函数 `price(provider, model, usage, tsMs)`（复用同一计价核心）；子会话/非 TUI 会话不安装，子会话命中父闸门时禁用自身看门狗以免重复中止。总线无副作用，实时累加器由 pi-subagent 侧持有，记账权威仍为 entries 现算。

### 降级恒等

- 未装/未升级任一侧时与升级前行为一致：无 `costContract` 标记的 entry 完全不归账，无总线时 pi-subagent 全 no-op；未收录模型不计金额亦不受共享闸门限制（已知边界）；跨 cwd 子代理 `check` 返回 `limit: null`，保守不误拦；不跨进程共享额度。

## [0.4.1] - 2026-09-13

### 修复

- `cost-radar` DeepSeek 官方现役 id **`deepseek-flash`**（及 `deepseek-flash-vision-exp`）此前未命中内置行、面板/账本显示「未收录」——官方定价页 model 列已改为 `deepseek-flash`（pro 仍为 `deepseek-v4-pro`），而 pi-ai 目录为 `deepseek-v4-flash`。现已将两个命名均收入 flash 行前缀，与 `deepseek-v4-flash` 同行同价（峰值 ¥2.0/¥0.04/¥8.0）。

## [0.4.0] - 2026-09-13

### 变更

- `cost-radar` DeepSeek 计价口径改为**人民币直读**：官方中文定价页（`api-docs.deepseek.com/zh-cn/quick_start/pricing`）按 ¥/M 公布，三条行（flash / pro / flash-vision-exp）由 `currency:"usd"`（USD × `usdRate`）改为 `currency:"cny"` 直读 ¥/M，不再受 `usdRate` 影响——与官方中国站账单逐位一致。旧口径在默认 `usdRate:7.2` 下比官方 CNY 价系统性偏高约 5.6%（峰值输入 flash ¥3.168 vs 官方 ¥3.0、pro ¥9.504 vs ¥9.0）；峰谷语义不变（off-peak = peak ×0.5，UTC 周一至周五 01:00-04:00 / 06:00-10:00）。当时价格：flash `3.0/0.10/9.0`、pro `9.0/0.30/27.0`（miss/hit/output，¥/M，峰值；flash 随后于同日官方复核下调，见下条）。
- 官方价复核（2026-09-13，覆盖官方定价页现役旗舰）：
  - **DeepSeek**：官方中文页 flash 峰值价下调 → `inputMiss 3.0→2.0`、`inputHit 0.10→0.04`、`output 9.0→8.0`（pro 不变）；`deepseek-v4-flash` 与 `-vision-exp` 同步，账目不再偏高。
  - **Anthropic**：现有五行价格未变；新增 **Fable 5 / Fable 5.1** 两行（`claude-fable-5` / `claude-fable-5-1`，$10/$12.50/$0.25~1/$50）——pi-ai 目录已收录而雷达此前未覆盖。
  - **OpenAI**：旧 gpt-4o / 4.1 系列价格未变，但补录**中代 gpt-5.x 十五行**（gpt-5 / 5-mini / 5-nano / 5-pro / 5.1 / 5.2 / 5.2-pro / 5.3-chat-latest / 5.3-codex（含 spark）/ 5.4 / 5.4-mini / 5.4-nano / 5.4-pro / 5.5 / 5.5-pro，与 pi-ai 目录 `cost` 一致）与**新旗舰四行**（gpt-6-astra / gpt-5.6-sol·terra·luna，Standard 短上下文档）。新旗舰官方新增独立 **cache writes** 档，`openai` 适配器 schema 扩展为可选 `cacheWrite` 字段（旧行保持三价、`cacheWrite` 仍防御按 input 计）；`_meta.source` 改为可解析的 `platform.openai.com/docs/pricing`。另修正既有前缀误配：`gpt-4o-mini` 此前被 `gpt-4o` 短前缀吞并（高估 16×）、`gpt-4o-2024-05-13` 按基础价计（应 $5），各补独立行。
  - **长上下文口径**：官方对 >272K input tokens 的请求整单按 `2×input/cache、1.5×output` 计（pi-ai `cost.tiers.inputTokensAbove=272000`）；cost-radar 的 usage 不含上下文长度与 `service_tier`，故统一取**短上下文 Standard** 档 golden——长上下文请求会低估（待 pi-ai 暴露该字段后建模）。
  - **Moonshot**：四项价格未变；定价页已由 `platform.moonshot.cn` 迁至 **`platform.kimi.com/docs/pricing/chat`**，四行 `_meta.source` 同步更新（旧链接失效）。
  - **Qwen**：两行价格未变。
  - 内置价格行 18 → **41 条**（DeepSeek 3 / Anthropic 7 / OpenAI 25 / Moonshot 4 / Qwen 2）；各适配器 `_meta.verifiedAt` 刷新至 **2026-09-13**。

---

## [0.3.0] - 2026-09-07

### 变更

- `cost-radar` 预算改为**开箱即用**：出厂默认 ¥5/会话（`cost-radar.json` 无 `defaultBudget` 字段或字段非法时回退 ¥5；`null` 语义改为「用户显式关闭」——0.2.0 未操作过预算的用户升级后自动启用默认预算，显式清除过的保持关闭）
- 面板预算页新增「设置本会话预算」（可高于或低于默认预算，仅本会话生效、`/new` 回落默认；`/cost budget ¥N` CLI 语义不变）与「清除本会话预算」（回落默认并明示回落值）
- 概念统一：会话级额度「提额」→「本会话预算」（超支三选一入口「① 提高本会话预算…」与面板共用同一写入语义；内部字段 `sessionOverride` 改名 `sessionBudget`）
- 行为变更：状态行预算段随默认 ¥5 启用而**默认显示**（0.2.0 默认隐藏）

## [0.2.0] - 2026-09-07

### 新增

- `cost-radar` 扩展 `/cost`：footer 状态区第 3 行常驻显示本会话累计费用（¥）与「续热 / 续冷 / 新会话」三档预估，附缓存 TTL 状态（⚡ 倒计时 / 🧊 过期 / ♻️ 重建）、预算进度与 💡 开新会话建议（`/cost off|on` 隐藏/恢复状态行）
- `/cost` 五页交互面板（总览 / 账本 / 预算 / 单价 / 设置）：←/→ 翻页、Esc 逐级退出；单价页按行 schema 录入并写回 `cost-radar.json`、支持「载入官方」与命名预设；设置页可改 USD→¥ 汇率
- 预算闸门与看门狗：`/cost budget ¥N` 设置默认预算（`clear` 清除）；超支时输入拦截三选一（仅本会话提额 / 仅本次忽略 / 暂停），回合内看门狗自动 `abort()` 防费用失控
- 人民币计价器：内置 5 族 18 条价格行——DeepSeek（deepseek-v4-flash/pro/vision-exp）、Anthropic（Claude Opus/Sonnet/Haiku 现役行）、OpenAI（gpt-4o / 4.1 / 4.1-mini / 4.1-nano）按官方 **USD** 价 × `usdRate` 折 ¥；Moonshot（moonshotai-cn/kimi-k3·k2.7-code·k2.7-code-highspeed·k2.6）与 Qwen（qwen3.8-max/flash）按官方 **CNY** 价直读。价格核对日期 **2026-09-07**，来源 URL 见各适配器 `_meta.source`（DeepSeek `api-docs.deepseek.com/quick_start/pricing`、Anthropic `docs.anthropic.com/.../pricing`、OpenAI `openai.com/api/pricing`、Moonshot `platform.moonshot.cn/docs/pricing/*`、Qwen `help.aliyun.com/zh/model-studio/billing-for-model-studio`）
- 未收录安全口径：不在内置清单或无法核价的模型只记 token、金额不计，面板提示等收录——CN 三族中 GLM 官方价页为 JS 渲染无法核对，暂未收录，留档 `extensions/cost-radar/adapters/PENDING.md`
- 单元测试：引入 vitest（`npm test` = `npx vitest run`），覆盖 `adapters`/`core`/`config`/`panel` 纯逻辑层

### 变更

- DeepSeek 计价口径修订：现役模型官方按 **USD** 公布（设计快照曾按 ¥/M 拟定）→ 记 USD、记账时 × `usdRate`；谷时 = 非峰值 ×0.5（`offPeakFactor: 0.5`），峰值窗 01:00-04:00 与 06:00-10:00（UTC、周一至周五）；已下架旧模型 deepseek-chat/reasoner 不收录

## [0.1.1] - 2025-07-14

### 新增

- `/zh-hotkeys` 命令：查看 Pi 全部快捷键的中文说明与用例（10 组 73 条）
- `scripts/check-coverage.ts`：发版前自动检测命令覆盖率（`preversion` hook）
- `/zh-commands` 修正：命令数量 23 → 22（与实际覆盖一致）

### 变更

- `/zh-hotkeys` 改为分组二级目录：一级分组列表 → 二级组内快捷键 → 详情页，Esc 逐级返回

## [0.1.0] - 2025-07-14

### 新增

- `/zh-commands` 命令：查看 Pi 全部 22 条命令的中文说明与用例
- TUI 交互界面：↑↓ 导航，Enter 查看详情，Esc 关闭

[0.3.0]: https://github.com/demon5395/pi-zh
[0.2.0]: https://github.com/demon5395/pi-zh
[0.1.1]: https://github.com/demon5395/pi-zh
[0.1.0]: https://github.com/demon5395/pi-zh
