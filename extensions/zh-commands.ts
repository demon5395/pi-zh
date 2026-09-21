/**
 * pi-zh — Pi 中文命令说明
 *
 * 提供 /zh-commands 命令，以 TUI 列表+详情方式展示所有 Pi 命令的中文说明。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

/** Pi 命令的中文元数据 */
interface CommandInfo {
  name: string;
  label: string;
  description: string;
  examples: string[];
  related?: string[];
}

const COMMANDS: CommandInfo[] = [
  {
    name: "login",
    label: "OAuth 认证",
    description: "登录或登出 OAuth 认证",
    examples: ["/login — 交互式选择提供商登录"],
    related: ["logout"],
  },
  {
    name: "logout",
    label: "登出",
    description: "登出当前 OAuth 认证",
    examples: ["/logout — 退出当前登录"],
    related: ["login"],
  },
  {
    name: "model",
    label: "切换模型",
    description: "切换当前 AI 模型",
    examples: [
      "/model claude",
      "/model openai/gpt-4o",
      "/model sonnet:high",
    ],
    related: ["scoped-models", "settings"],
  },
  {
    name: "settings",
    label: "设置",
    description: "调整各项设置（主题、思维层级、消息投递等）",
    examples: ["/settings — 打开设置界面交互操作"],
    related: ["model"],
  },
  {
    name: "scoped-models",
    label: "模型范围",
    description: "启用或禁用 Ctrl+P 循环的模型列表",
    examples: ["/scoped-models — 管理循环切换的模型"],
    related: ["model"],
  },
  {
    name: "resume",
    label: "恢复会话",
    description: "浏览并恢复历史会话",
    examples: ["/resume — 浏览并选择之前保存的会话"],
    related: ["new", "session"],
  },
  {
    name: "new",
    label: "新建会话",
    description: "清空当前会话重新开始",
    examples: ["/new — 开始一个全新的会话"],
    related: ["resume"],
  },
  {
    name: "name",
    label: "命名会话",
    description: "设置当前会话的显示名称",
    examples: ["/name 重构用户模块"],
    related: ["session"],
  },
  {
    name: "session",
    label: "会话信息",
    description: "查看当前会话详情（文件路径、ID、消息数、Token、费用）",
    examples: ["/session — 显示完整的会话信息"],
    related: ["name", "tree", "export"],
  },
  {
    name: "tree",
    label: "会话树",
    description: "在会话树中导航，可回溯到任意历史节点继续对话",
    examples: ["/tree — 进入树状视图浏览分支",
      "↑↓                     导航",
      "←/→                    翻页",
      "Ctrl+←/→               切换分支",
      "Shift+L                添加标签",
      "Shift+T                添加时间标签",
      "Ctrl+D/T/U/L/A         筛选器(D标签/T时间/U用户/L助手/A所有消息)",
      "Ctrl+O / Shift+Ctrl+O  循环切换筛选器",
      "Type to search:        搜索会话"],
    related: ["fork", "session"],
  },
  {
    name: "trust",
    label: "项目信任",
    description: "保存当前项目的信任决定，允许加载项目本地配置",
    examples: ["/trust — 信任当前项目文件夹"],
  },
  {
    name: "fork",
    label: "分支会话",
    description: "从之前某条用户消息创建新的分支会话",
    examples: ["/fork — 选择节点创建分支"],
    related: ["clone", "tree"],
  },
  {
    name: "clone",
    label: "克隆会话",
    description: "复制当前活动分支的全部历史到新会话文件中",
    examples: ["/clone — 复制当前分支为新会话"],
    related: ["fork"],
  },
  {
    name: "compact",
    label: "压缩上下文",
    description: "手动压缩上下文，总结早期消息以释放 Token 空间",
    examples: [
      "/compact",
      "/compact 保留最近的架构决策",
    ],
    related: ["session"],
  },
  {
    name: "copy",
    label: "复制消息",
    description: "将最后一条助手消息复制到系统剪贴板",
    examples: ["/copy — 复制最后一条助手消息"],
  },
  {
    name: "export",
    label: "导出会话",
    description: "将会话导出为 HTML 或 JSONL 文件",
    examples: [
      "/export session.html",
      "/export session.jsonl",
    ],
    related: ["import", "share"],
  },
  {
    name: "import",
    label: "导入会话",
    description: "从 JSONL 文件导入并恢复历史会话",
    examples: ["/import session.jsonl"],
    related: ["export"],
  },
  {
    name: "share",
    label: "分享会话",
    description: "将会话上传为私有 GitHub Gist，生成可分享的 HTML 链接",
    examples: ["/share — 上传并获取分享链接"],
    related: ["export"],
  },
  {
    name: "reload",
    label: "重载配置",
    description: "重载快捷键、扩展、技能、提示词和上下文文件（主题自动热重载）",
    examples: ["/reload — 重新加载所有配置"],
  },
  {
    name: "hotkeys",
    label: "快捷键",
    description: "显示 Pi 所有键盘快捷键的完整列表",
    examples: ["/hotkeys — 查看全部快捷键"],
    related: ["reload"],
  },
  {
    name: "changelog",
    label: "更新日志",
    description: "显示 Pi 的版本历史和更新记录",
    examples: ["/changelog — 查看版本更新"],
  },
  {
    name: "quit",
    label: "退出",
    description: "退出 Pi 程序",
    examples: ["/quit — 退出 Pi"],
  },
];

/** pi-zh 扩展入口：注册 /zh-commands 命令 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("zh-commands", {
    description: "以中文查看 Pi 所有命令及其用例",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("zh-commands 需要 TUI 模式", "error");
        return;
      }
      await showZhCommands(ctx);
    },
  });
}

/** TUI 交互入口：展示命令选择列表和详情 */
async function showZhCommands(ctx: any): Promise<void> {
  await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    let selectedCommand: CommandInfo | null = null;

    const selectItems = COMMANDS.map((cmd) => ({
      value: cmd.name,
      label: `/${cmd.name}`,
      description: cmd.label,
    }));

    const selectList = new SelectList(selectItems, Math.min(selectItems.length + 2, 22), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => {
      const cmd = COMMANDS.find((c) => c.name === item.value);
      if (cmd) {
        selectedCommand = cmd;
      }
    };

    selectList.onCancel = () => done(null);

    // Use Container only for the list view
    const container = new Container();
    container.addChild(makeBorder(theme, "accent"));
    container.addChild(new Text(
      theme.fg("accent", theme.bold(" Pi 命令中文说明 ")),
      1, 0
    ));
    container.addChild(selectList);
    container.addChild(new Text(
      theme.fg("dim", " ↑↓ 导航 • Enter 查看 • Esc 关闭"),
      1, 0
    ));
    container.addChild(makeBorder(theme, "accent"));

    return {
      render: (w: number) => {
        if (selectedCommand) {
          return buildDetailLines(selectedCommand, theme, w);
        }
        return container.render(w);
      },
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (selectedCommand) {
          selectedCommand = null;
          container.invalidate();
          tui.requestRender();
        } else {
          selectList.handleInput(data);
          tui.requestRender();
        }
      },
    };
  });
}

/** 渲染单个命令的详情页面（说明 + 用例 + 关联命令） */
function buildDetailLines(cmd: CommandInfo, theme: any, width: number): string[] {
  const border = theme.fg("accent", "─".repeat(Math.max(1, width)));
  const lines: string[] = [];

  lines.push(border);
  lines.push(` ${theme.fg("accent", theme.bold(`/${cmd.name}`))}`);
  lines.push(` ${theme.fg("text", cmd.label)}`);
  lines.push("");

  // Description
  lines.push(` ${theme.fg("dim", "📋 说明：")}`);
  lines.push(` ${theme.fg("text", cmd.description)}`);
  lines.push("");

  // Examples
  lines.push(` ${theme.fg("dim", "💡 用例：")}`);
  for (const example of cmd.examples) {
    lines.push(` ${theme.fg("muted", example)}`);
  }

  // Related
  if (cmd.related && cmd.related.length > 0) {
    lines.push("");
    lines.push(` ${theme.fg("dim", "🔗 关联命令：")}`);
    const relatedText = cmd.related.map((r) => `/${r}`).join("  ");
    lines.push(` ${theme.fg("muted", relatedText)}`);
  }

  lines.push("");
  lines.push(` ${theme.fg("dim", "Enter 返回 • Esc 关闭")}`);
  lines.push(border);

  return lines;
}

/** 创建水平装饰边框（TUI 组件） */
function makeBorder(theme: any, color: string) {
  return {
    render: (w: number) => [theme.fg(color, "─".repeat(Math.max(1, w)))],
    invalidate: () => {},
  };
}
