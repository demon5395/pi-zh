# pi-zh

Pi 中文用户的实用工具集 — `/zh-commands` 查看 Pi 命令中文说明，`/zh-hotkeys` 查看 Pi 快捷键中文说明，`/cost` 费用雷达（累计费用 / 预估 / 预算闸门），`/codex-safe` Codex 出口守卫（诊断线路是否真走代理并落地在受支持地区）。

**22 条命令中文元数据** · **10 组 73 条快捷键中文元数据** · **人民币计价 + 峰谷识别** · **预算闸门与看门狗** · **`/zh-commands`、`/zh-hotkeys`、`/cost` 纯本地、不联网** · **`/codex-safe` 会联网（对 OpenAI/Cloudflare 域名的公开 trace 端点做无凭证探针），需要配置**

## 安装与快速开始

```bash
# 方式一：本地路径（在本仓库根目录执行）
pi install ./

# 方式二：临时加载（不写 settings）
pi -e ./

# 方式三：Git 远程（生产）
pi install https://github.com/demon5395/pi-zh
```

加载成功后看到 `Extensions (1): pi-zh` 即完成。移除：`pi remove pi-zh`。

## 主要命令

| 命令 | 作用 |
|------|------|
| `/zh-commands` | TUI 列出 22 条 Pi 命令中文说明，↑↓ 导航，Enter 查看详情（说明 + 用例 + 关联命令） |
| `/zh-hotkeys` | TUI 列出 10 组 73 条快捷键中文说明（分组二级目录），↑↓ 导航，Enter 查看详情 |
| `/cost` | 费用雷达五页面板：总览 / 账本 / 预算 / 单价 / 设置（←/→ 翻页，Esc 逐级退出） |
| `/cost budget ¥N` | 设置默认预算（写入配置文件，全局会话共用）；`/cost budget clear` 清除 |
| `/cost off` / `/cost on` | 隐藏 / 恢复状态行 |
| `/codex-safe` | Codex 出口守卫：诊断请求是否真的走了代理且落地在受支持地区；不安全时拦下输入并二次确认 |

`/cost` 在 footer 状态区第 3 行常驻显示本会话累计费用（¥）与「续热 / 续冷 / 新会话」三档预估，附缓存 TTL 状态、预算进度与 💡 开新会话建议；内置人民币计价器（USD 族按官方美元价 × `usdRate` 折 ¥，CNY 族直读官方人民币价）。预算闸门：达到生效额度后，下一条输入会被拦下弹出三选一（提高本会话预算 / 仅本次忽略 / 暂停并丢弃）；回合内继续超支由看门狗自动中止后续调用。cost-radar 与 [pi-subagent](https://github.com/demon5395/pi/pi-subagent) 协作，可把子代理消耗并入父会话账本并共享额度。

## 配置

cost-radar 配置默认位于 `~/.pi/agent/cost-radar.json`（`PI_CODING_AGENT_DIR` 可覆盖目录）；文件缺失或损坏时回退默认值并告警；写入采用临时文件 + 原子 rename（权限 0600）。

| 字段 | 说明 |
|------|------|
| `defaultBudget` | ¥/会话默认预算，出厂 **5**；`null` = 用户显式关闭（等价 `/cost budget clear`） |
| `usdRate` | USD 计价族 → ¥ 汇率（Anthropic / OpenAI；CNY 族 DeepSeek / Moonshot / Qwen 不受影响） |
| `priceOverrides` | 模型行单价覆盖（key 必须是内置清单行 key，字段须属于该行 schema） |
| `userPresets` | 命名覆盖快照（`/cost` 单价页「保存为预设 / 载入 / 删除」） |

以上均可通过 `/cost` 面板（单价 / 预算 / 设置页）与 `/cost budget` 命令修改，无需手改文件。

---

## /codex-safe — Codex 出口守卫

**它解决什么**：OpenAI Codex 对出口 IP 所在国家/地区有白名单限制。已持有有效 token 后，若 Clash 规则静默失效（规则更新、订阅切换、节点故障回落到 DIRECT），推理请求会从不受支持地区发出而用户毫无察觉——这正是封号风险所在。登录失败会被 OpenAI 的 403 直接挡住，是天然兜底，不是本守卫的目标。

**它做不到什么**：本地扩展改不了出口 IP，也绕过不了地域封锁，只能把不安全的线路「变成看得见、拦得住」。且硬闸只覆盖**交互式用户输入**：同一轮内的续写、自动重试、子代理调用只能靠每 10s（`cacheTtlMs`）的周期复检 + `ctx.abort()` 兜底，存在约 10s 的残余窗口。

命令：

| 命令 | 作用 |
|------|------|
| `/codex-safe` | 等价 `/codex-safe doctor`：多哨兵域名双路探针（经代理 vs 直连出口对比），输出逐域名与整体判定 |
| `/codex-safe doctor` | 诊断请求是否真的走了代理、出口落地在哪个地区、整体是否安全 |
| `/codex-safe proxy` | 显示配置文件里的 `httpProxy` 与当前进程实际生效值（并标注两者是否一致） |
| `/codex-safe proxy set <url>` | 读写 pi `settings.json` 的 `httpProxy`（保留其它字段、原子写 + 备份），仅接受 `http://` / `https://` |
| `/codex-safe proxy clear` | 删除 `settings.json` 的 `httpProxy` 字段（同样原子写 + 备份） |
| `/codex-safe proxy test` | 用「当前进程生效线路」再测一次（走当前进程的 `HTTP_PROXY`，**不受刚 `proxy set` 的新值影响**）；要验证新代理必须重启 pi |
| `/codex-safe on` / `/codex-safe off` | 闸门总开关（写入 `codex-safe.json`） |

配置（`~/.pi/agent/codex-safe.json`，`PI_CODING_AGENT_DIR` 可覆盖目录）：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 闸门总开关（`/codex-safe on`/`off`） |
| `proxyUrl` | string | `http://127.0.0.1:7890` | 期望代理；用于与 pi 实际值比对 |
| `sentinels` | string[] | `["auth.openai.com", "chatgpt.com", "api.openai.com"]` | 哨兵域名 |
| `allowedRegions` | string[] | `["US","CA","GB","DE","NL","FR","JP","SG","KR","AU"]` | 地区白名单（不含猜测条目；`["*"]` = 跳过地区校验，不推荐） |
| `probeTimeoutMs` | number | `5000` | 单探针超时 |
| `cacheTtlMs` | number | `10000` | 判定缓存与后台复检周期 |
| `noUiPolicy` | `"warn"` \| `"block"` | `"warn"` | **仅在 `ctx.hasUI === false`（json / print）时生效**；TUI / RPC 一律二次确认 |

**两个必须记住的坑**：

- `httpProxy` 只在 pi 启动时注入 `process.env`，**改完必须重启 pi** 才生效；运行期写 `settings.json` 不影响当前进程（`/codex-safe proxy test` 只能复测当前生效线路，**不能**验证新设置的值）。
- pi 用 `process.env.HTTP_PROXY ??= proxy` 注入（**`??=`，不覆盖已有值**）：若 shell 已导出 `HTTP_PROXY` / `HTTPS_PROXY`，`settings.json` 的 `httpProxy` 会被绕过、完全不生效。

## Docker 容器（Mac 宿主机 + Linux 容器）

代理跑在 Mac 宿主机、Pi/Codex 跑在 Linux 容器时，容器内的 `127.0.0.1` / `localhost` / `::1` 指向**容器自身**，默认的 `http://127.0.0.1:7890` 不可达。请在**启动 Pi 之前**把代理改为主机别名 `host.docker.internal`。

### 方式一：Compose 注入环境变量

```yaml
services:
  pi:
    image: node:22-slim
    environment:
      HTTP_PROXY: http://host.docker.internal:7890
      HTTPS_PROXY: http://host.docker.internal:7890
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ~/.pi:/root/.pi
    working_dir: /root
    command: ["pi"]
```

`extra_hosts` 是 Linux 原生 Docker（含 Docker Desktop 的 Linux 容器）的兜底：Mac Docker Desktop 通常已内置 `host.docker.internal`，显式声明可兼容未内置的环境。

### 方式二：写入 Pi `settings.json` 的 `httpProxy`

```bash
/codex-safe proxy set http://host.docker.internal:7890
```

或手改 `~/.pi/agent/settings.json` 的 `httpProxy` 字段。**两种方式都必须在修改后重启 Pi**：`httpProxy` 只在启动时注入 `process.env`。

### codex-safe 的容器行为

- 扩展通过容器内的 `/.dockerenv` 识别容器，并把配置/环境中的回环代理（`127.0.0.1`、`localhost`、`::1`）解析为运行时地址 `http://host.docker.internal:<port>`（保留协议、端口、认证与路径）；非回环地址原样不变。
- 解析结果只用于**诊断与探针**，不会写回 `codex-safe.json`（不持久化容器专用地址）。
- 扩展**不在运行期接管 Pi 的全局 dispatcher**；若当前进程实际生效的代理仍是容器不可达的回环地址，`/codex-safe doctor` / `/codex-safe proxy` 会同时展示**原始地址**与**运行时地址**，并报告「启动配置错误」——需改为运行时地址并重启 Pi，**不会降级为直连**，安全闸门也不会放行。

### `host.docker.internal` 无法解析时排查

1. 容器内执行 `getent hosts host.docker.internal`，确认能解析到宿主网关 IP；
2. 若解析失败，在 Compose 服务下加 `extra_hosts: ["host.docker.internal:host-gateway"]` 后重建容器；
3. 确认 Docker Desktop 已启动且容器网络非 `none`；
4. `/codex-safe doctor` / `/codex-safe proxy` 在宿主名无法解析时会在运行时地址旁给出警告，改写仍生效；按提示补齐 `extra_hosts` 后重启 Pi。

