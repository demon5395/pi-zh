/**
 * pi-zh — Pi 快捷键中文说明
 *
 * 提供 /zh-hotkeys 命令，以 TUI 列表+详情方式展示 Pi 所有快捷键的中文说明。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { HOTKEYS, GROUP_DESCRIPTIONS, type HotkeyInfo } from "../data/hotkeys-data";

/** 无默认按键时的展示文案 */
const NO_DEFAULT_KEYS = "（无默认键）";

/** 空数据时的中文空态文案 */
const EMPTY_DATA_TEXT = "（暂无快捷键数据）";

/** pi-zh 扩展入口：注册 /zh-hotkeys 命令 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("zh-hotkeys", {
    description: "以中文查看 Pi 所有快捷键及其说明",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("zh-hotkeys 需要 TUI 模式", "error");
        return;
      }
      await showZhHotkeys(ctx);
    },
  });
}

/** TUI 交互入口：分组列表 → 组内快捷键列表 → 详情，Esc 逐级返回 */
async function showZhHotkeys(ctx: any): Promise<void> {
  await ctx.ui.custom((tui: any, theme: any, kb: any, done: any) => {
    // ── 视图层级状态 ──────────────────────────────
    // viewLevel: 0=分组列表, 1=组内列表, 2=详情
    let viewLevel = 0;
    let selectedGroup: string | null = null;
    let selectedHotkey: HotkeyInfo | null = null;

    // SelectList 主题（一级/二级共用）
    const listTheme = {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    };

    // ── 一级：分组 SelectList（10 个分组）────────────
    const groupNames = [...new Set(HOTKEYS.map((h) => h.group))];
    const groupItems = groupNames.map((g) => ({
      value: g,
      label: g,
      description: `(${HOTKEYS.filter((h) => h.group === g).length}) ${GROUP_DESCRIPTIONS[g] ?? ""}`,
    }));

    const groupList =
      groupItems.length > 0
        ? new SelectList(groupItems, Math.min(groupItems.length + 2, 22), listTheme)
        : null;

    // 一级视图容器：标题/列表/提示固定不变
    const groupContainer = new Container();
    groupContainer.addChild(makeBorder(theme, "accent"));
    groupContainer.addChild(new Text(
      theme.fg("accent", theme.bold(" Pi 快捷键分组 ")),
      1, 0
    ));
    groupContainer.addChild(groupList ?? new Text(theme.fg("muted", EMPTY_DATA_TEXT), 1, 0));
    groupContainer.addChild(new Text(
      theme.fg("dim", " ↑↓ 导航 • Enter 进入分组 • Esc 关闭"),
      1, 0
    ));
    groupContainer.addChild(makeBorder(theme, "accent"));

    // ── 二级：组内快捷键列表（进入分组时动态重建）────
    // 独立容器避免直接操作 Container 内部结构
    let hotkeyList: SelectList | null = null;
    const hotkeyContainer = new Container();

    /** 按 selectedGroup 重建二级列表容器 */
    function rebuildHotkeyList() {
      hotkeyContainer.clear();
      hotkeyContainer.addChild(makeBorder(theme, "accent"));
      hotkeyContainer.addChild(new Text(
        theme.fg("accent", theme.bold(` ${selectedGroup ?? ""} `)),
        1, 0
      ));
      const hotkeyItems = HOTKEYS.filter((h) => h.group === selectedGroup).map((h) => ({
        value: h.id,
        label: h.keys.length > 0 ? h.keys.join(", ") : NO_DEFAULT_KEYS,
        description: h.label,
      }));
      hotkeyList =
        hotkeyItems.length > 0
          ? new SelectList(hotkeyItems, Math.min(hotkeyItems.length + 2, 22), listTheme)
          : null;
      hotkeyContainer.addChild(hotkeyList ?? new Text(theme.fg("muted", EMPTY_DATA_TEXT), 1, 0));
      hotkeyContainer.addChild(new Text(
        theme.fg("dim", " ↑↓ 导航 • Enter 查看详情 • Esc 返回"),
        1, 0
      ));
      hotkeyContainer.addChild(makeBorder(theme, "accent"));

      if (hotkeyList) {
        hotkeyList.onSelect = (item) => {
          const hk = HOTKEYS.find((h) => h.id === item.value);
          if (hk) {
            selectedHotkey = hk;
            viewLevel = 2;
          }
        };
        hotkeyList.onCancel = () => {
          // 组内列表 Esc → 返回分组列表
          selectedGroup = null;
          viewLevel = 0;
          groupContainer.invalidate();
          tui.requestRender();
        };
      }
    }

    if (groupList) {
      groupList.onSelect = (item) => {
        selectedGroup = item.value;
        viewLevel = 1;
        rebuildHotkeyList();
        hotkeyContainer.invalidate();
        tui.requestRender();
      };
      groupList.onCancel = () => done(null);
    }

    return {
      render: (w: number) => {
        const lines =
          viewLevel === 2 && selectedHotkey
            ? buildDetailLines(selectedHotkey, theme, w)
            : viewLevel === 1
              ? hotkeyContainer.render(w)
              : groupContainer.render(w);
        // 统一截断到终端宽度，避免超宽行导致 pi-tui 渲染器抛错
        return lines.map((line) =>
          visibleWidth(line) > w ? truncateToWidth(line, w, "") : line
        );
      },
      invalidate: () => {
        groupContainer.invalidate();
        hotkeyContainer.invalidate();
      },
      handleInput: (data: string) => {
        if (viewLevel === 2 && selectedHotkey) {
          // 详情：任意键返回组内列表（与 zh-commands 详情页行为一致）
          selectedHotkey = null;
          viewLevel = 1;
          hotkeyContainer.invalidate();
          tui.requestRender();
        } else if (viewLevel === 1) {
          if (hotkeyList) {
            hotkeyList.handleInput(data);
          } else if (kb.matches(data, "tui.select.cancel")) {
            // 组内空态：Esc 返回分组列表
            selectedGroup = null;
            viewLevel = 0;
            groupContainer.invalidate();
          }
          tui.requestRender();
        } else if (viewLevel === 0) {
          if (groupList) {
            groupList.handleInput(data);
          } else if (kb.matches(data, "tui.select.cancel")) {
            // 空数据模式：Esc/Ctrl+C 直接关闭
            done(null);
            return;
          }
          tui.requestRender();
        }
      },
    };
  });
}

/** 渲染单个快捷键的详情页面（默认按键 + 分组标签 + 说明 + 绑定 id） */
function buildDetailLines(hk: HotkeyInfo, theme: any, width: number): string[] {
  const border = theme.fg("accent", "─".repeat(Math.max(1, width)));
  const keysText = hk.keys.length > 0 ? hk.keys.join(", ") : NO_DEFAULT_KEYS;
  const lines: string[] = [];

  lines.push(border);
  lines.push(` ${theme.fg("accent", theme.bold(keysText))}`);
  lines.push(` ${theme.fg("text", `[${hk.group}] ${hk.label}`)}`);
  lines.push("");

  // Default keys
  lines.push(` ${theme.fg("dim", "🔧 默认按键：")}`);
  lines.push(` ${theme.fg("muted", keysText)}`);
  lines.push("");

  // Description
  lines.push(` ${theme.fg("dim", "📋 说明：")}`);
  lines.push(` ${theme.fg("text", hk.description)}`);
  lines.push("");

  // Binding id
  lines.push(` ${theme.fg("dim", "🔗 绑定 id：")}`);
  lines.push(` ${theme.fg("muted", hk.id)}`);
  lines.push("");

  lines.push(` ${theme.fg("dim", "任意键返回列表 • Esc 逐级返回")}`);
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
