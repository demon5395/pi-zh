/**
 * pi-zh — Pi 快捷键中文元数据
 *
 * 数据来源：Pi 官方 keybindings.md 文档（keybinding id / 默认按键 / 英文说明）
 * 维护说明：Pi 新增快捷键时同步补充；id 字段保持与官方 keybinding id 一致。
 * 当前收录：10 组 73 条。
 */

/** 快捷键中文元数据 */
export interface HotkeyInfo {
  id: string;          // 官方 keybinding id，如 "app.model.cycleForward"
  keys: string[];      // 默认按键，如 ["ctrl+p"]
  label: string;       // 中文标签
  description: string; // 中文说明
  group: string;       // 分组名
}

/** 分组中文说明（一级目录展示用） */
export const GROUP_DESCRIPTIONS: Record<string, string> = {
  "编辑器光标移动": "光标上下左右移动、翻页、跳转字符",
  "编辑器删除": "删除字符/单词/行，撤销编辑",
  "输入": "换行、提交、Tab 补全",
  "剪贴板与选择": "复制/粘贴、Kill Ring、列表选择",
  "应用": "取消/退出/挂起、外部编辑器、粘贴图片",
  "会话": "新建/恢复/分支/重命名/删除会话",
  "模型与思考": "切换模型、循环切换思考层级",
  "消息队列": "展开工具输出、复制消息、排队追加",
  "树导航": "会话树折叠/展开、过滤、标签编辑",
  "模型选择器": "保存/启用/排序模型选择",
};

export const HOTKEYS: HotkeyInfo[] = [
  // ── 编辑器：光标移动 ────────────────────────────────────────
  {
    id: "tui.editor.cursorUp",
    keys: ["up"],
    label: "光标上移",
    description: "将光标向上移动一行",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.cursorDown",
    keys: ["down"],
    label: "光标下移",
    description: "将光标向下移动一行",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.cursorLeft",
    keys: ["left", "ctrl+b"],
    label: "光标左移",
    description: "将光标向左移动一列",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.cursorRight",
    keys: ["right", "ctrl+f"],
    label: "光标右移",
    description: "将光标向右移动一列",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.cursorWordLeft",
    keys: ["alt+left", "ctrl+left", "alt+b"],
    label: "光标左移一个单词",
    description: "将光标向左移动一个单词",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.cursorWordRight",
    keys: ["alt+right", "ctrl+right", "alt+f"],
    label: "光标右移一个单词",
    description: "将光标向右移动一个单词",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.cursorLineStart",
    keys: ["home", "ctrl+a"],
    label: "跳到行首",
    description: "将光标移动到行首",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.cursorLineEnd",
    keys: ["end", "ctrl+e"],
    label: "跳到行尾",
    description: "将光标移动到行尾",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.jumpForward",
    keys: ["ctrl+]"],
    label: "向前跳转",
    description: "向前跳转到指定字符",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.jumpBackward",
    keys: ["ctrl+alt+]"],
    label: "向后跳转",
    description: "向后跳转到指定字符",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.pageUp",
    keys: ["pageUp"],
    label: "向上翻页",
    description: "向上滚动一页",
    group: "编辑器光标移动",
  },
  {
    id: "tui.editor.pageDown",
    keys: ["pageDown"],
    label: "向下翻页",
    description: "向下滚动一页",
    group: "编辑器光标移动",
  },

  // ── 编辑器：删除 ────────────────────────────────────────
  {
    id: "tui.editor.deleteCharBackward",
    keys: ["backspace"],
    label: "删除光标前字符",
    description: "删除光标前的字符",
    group: "编辑器删除",
  },
  {
    id: "tui.editor.deleteCharForward",
    keys: ["delete", "ctrl+d"],
    label: "删除光标处字符",
    description: "删除光标处的字符",
    group: "编辑器删除",
  },
  {
    id: "tui.editor.deleteWordBackward",
    keys: ["ctrl+w", "alt+backspace"],
    label: "删除光标前单词",
    description: "删除光标前的单词",
    group: "编辑器删除",
  },
  {
    id: "tui.editor.deleteWordForward",
    keys: ["alt+d", "alt+delete"],
    label: "删除光标后单词",
    description: "删除光标后的单词",
    group: "编辑器删除",
  },
  {
    id: "tui.editor.deleteToLineStart",
    keys: ["ctrl+u"],
    label: "删除到行首",
    description: "删除从光标到行首的内容",
    group: "编辑器删除",
  },
  {
    id: "tui.editor.deleteToLineEnd",
    keys: ["ctrl+k"],
    label: "删除到行尾",
    description: "删除从光标到行尾的内容",
    group: "编辑器删除",
  },

  // ── 输入 ────────────────────────────────────────
  {
    id: "tui.input.newLine",
    keys: ["shift+enter", "ctrl+j"],
    label: "插入换行",
    description: "插入换行（多行输入）",
    group: "输入",
  },
  {
    id: "tui.input.submit",
    keys: ["enter"],
    label: "提交输入",
    description: "提交当前输入",
    group: "输入",
  },
  {
    id: "tui.input.tab",
    keys: ["tab"],
    label: "Tab/自动补全",
    description: "Tab 键：缩进或自动补全",
    group: "输入",
  },

  // ── 剪贴板与选择 ────────────────────────────────────────
  {
    id: "tui.editor.yank",
    keys: ["ctrl+y"],
    label: "粘贴最近删除文本",
    description: "粘贴最近删除的文本",
    group: "剪贴板与选择",
  },
  {
    id: "tui.editor.yankPop",
    keys: ["alt+y"],
    label: "粘贴后循环切换",
    description: "粘贴后循环切换更早删除的文本",
    group: "剪贴板与选择",
  },
  {
    id: "tui.editor.undo",
    keys: ["ctrl+-"],
    label: "撤销",
    description: "撤销上一次编辑（与删除/剪切操作配合的恢复机制）",
    group: "剪贴板与选择",
  },
  {
    id: "tui.input.copy",
    keys: ["ctrl+c"],
    label: "复制选中内容",
    description: "复制选中的内容",
    group: "剪贴板与选择",
  },
  {
    id: "tui.select.up",
    keys: ["up"],
    label: "选择上移",
    description: "选择项上移",
    group: "剪贴板与选择",
  },
  {
    id: "tui.select.down",
    keys: ["down"],
    label: "选择下移",
    description: "选择项下移",
    group: "剪贴板与选择",
  },
  {
    id: "tui.select.pageUp",
    keys: ["pageUp"],
    label: "列表向上翻页",
    description: "在选择列表中向上翻一页",
    group: "剪贴板与选择",
  },
  {
    id: "tui.select.pageDown",
    keys: ["pageDown"],
    label: "列表向下翻页",
    description: "在选择列表中向下翻一页",
    group: "剪贴板与选择",
  },
  {
    id: "tui.select.confirm",
    keys: ["enter"],
    label: "确认选择",
    description: "确认当前选择",
    group: "剪贴板与选择",
  },
  {
    id: "tui.select.cancel",
    keys: ["escape", "ctrl+c"],
    label: "取消选择",
    description: "取消选择并关闭列表",
    group: "剪贴板与选择",
  },

  // ── 应用 ────────────────────────────────────────
  {
    id: "app.interrupt",
    keys: ["escape"],
    label: "取消/中止",
    description: "取消或中止当前操作",
    group: "应用",
  },
  {
    id: "app.clear",
    keys: ["ctrl+c"],
    label: "清空编辑器",
    description: "清空编辑器内容",
    group: "应用",
  },
  {
    id: "app.exit",
    keys: ["ctrl+d"],
    label: "退出",
    description: "退出 Pi（编辑器为空时）",
    group: "应用",
  },
  {
    id: "app.suspend",
    keys: ["ctrl+z"],
    label: "挂起到后台",
    description: "将 Pi 挂起到后台",
    group: "应用",
  },
  {
    id: "app.editor.external",
    keys: ["ctrl+g"],
    label: "外部编辑器打开",
    description: "在外部编辑器中打开（$VISUAL/$EDITOR 等）",
    group: "应用",
  },
  {
    id: "app.clipboard.pasteImage",
    keys: ["ctrl+v", "alt+v"],
    label: "粘贴剪贴板图片",
    description: "从剪贴板粘贴图片（Windows 下为 alt+v）",
    group: "应用",
  },

  // ── 会话 ────────────────────────────────────────
  {
    id: "app.session.new",
    keys: [],
    label: "新建会话",
    description: "新建会话（/new）",
    group: "会话",
  },
  {
    id: "app.session.tree",
    keys: [],
    label: "打开会话树",
    description: "打开会话树导航器（/tree）",
    group: "会话",
  },
  {
    id: "app.session.fork",
    keys: [],
    label: "分支当前会话",
    description: "分支当前会话（/fork）",
    group: "会话",
  },
  {
    id: "app.session.resume",
    keys: [],
    label: "打开会话恢复选择器",
    description: "打开会话恢复选择器（/resume）",
    group: "会话",
  },
  {
    id: "app.session.togglePath",
    keys: ["ctrl+p"],
    label: "切换路径显示",
    description: "切换会话路径显示",
    group: "会话",
  },
  {
    id: "app.session.toggleSort",
    keys: ["ctrl+s"],
    label: "切换排序方式",
    description: "切换会话排序方式",
    group: "会话",
  },
  {
    id: "app.session.toggleNamedFilter",
    keys: ["ctrl+n"],
    label: "切换仅命名会话过滤",
    description: "切换仅显示已命名会话的过滤",
    group: "会话",
  },
  {
    id: "app.session.rename",
    keys: ["ctrl+r"],
    label: "重命名会话",
    description: "重命名当前会话",
    group: "会话",
  },
  {
    id: "app.session.delete",
    keys: ["ctrl+d"],
    label: "删除会话",
    description: "删除当前会话",
    group: "会话",
  },
  {
    id: "app.session.deleteNoninvasive",
    keys: ["ctrl+backspace"],
    label: "查询为空时删除会话",
    description: "当会话列表搜索框为空时直接删除当前会话，避免误删已筛选结果",
    group: "会话",
  },

  // ── 模型与思考 ────────────────────────────────────────
  {
    id: "app.model.select",
    keys: ["ctrl+l"],
    label: "打开模型选择器",
    description: "打开模型选择器（等价于 /model 命令的交互界面）",
    group: "模型与思考",
  },
  {
    id: "app.model.cycleForward",
    keys: ["ctrl+p"],
    label: "循环切换下一个模型",
    description: "循环切换到下一个模型",
    group: "模型与思考",
  },
  {
    id: "app.model.cycleBackward",
    keys: ["shift+ctrl+p"],
    label: "循环切换上一个模型",
    description: "循环切换到上一个模型",
    group: "模型与思考",
  },
  {
    id: "app.thinking.cycle",
    keys: ["shift+tab"],
    label: "循环切换思考层级",
    description: "在无思考/低/中/高等层级之间循环切换",
    group: "模型与思考",
  },
  {
    id: "app.thinking.toggle",
    keys: ["ctrl+t"],
    label: "折叠或展开思考块",
    description: "在对话中折叠或展开模型的思考过程内容",
    group: "模型与思考",
  },

  // ── 消息队列 ────────────────────────────────────────
  {
    id: "app.tools.expand",
    keys: ["ctrl+o"],
    label: "折叠或展开工具输出",
    description: "在对话中折叠或展开工具调用的输出结果",
    group: "消息队列",
  },
  {
    id: "app.message.copy",
    keys: ["ctrl+x"],
    label: "复制最后一条助手消息",
    description: "复制最后一条助手消息（或 /tree 中选中的消息）",
    group: "消息队列",
  },
  {
    id: "app.message.followUp",
    keys: ["alt+enter"],
    label: "排队追加消息",
    description: "排队追加消息（不打断当前回复）",
    group: "消息队列",
  },
  {
    id: "app.message.dequeue",
    keys: ["alt+up"],
    label: "恢复已排队消息",
    description: "将已排队的消息恢复到编辑器",
    group: "消息队列",
  },

  // ── 树导航 ────────────────────────────────────────
  {
    id: "app.tree.foldOrUp",
    keys: ["ctrl+left", "alt+left"],
    label: "折叠分支段或跳到上段",
    description: "折叠当前分支段，或跳到上一个分支段起点",
    group: "树导航",
  },
  {
    id: "app.tree.unfoldOrDown",
    keys: ["ctrl+right", "alt+right"],
    label: "展开分支段或跳到下段",
    description: "展开当前分支段，或跳到下一个分支段起点/分支末尾",
    group: "树导航",
  },
  {
    id: "app.tree.editLabel",
    keys: ["shift+l"],
    label: "编辑树节点标签",
    description: "编辑选中树节点的标签",
    group: "树导航",
  },
  {
    id: "app.tree.toggleLabelTimestamp",
    keys: ["shift+t"],
    label: "切换标签时间戳",
    description: "在树中切换标签时间戳显示",
    group: "树导航",
  },
  {
    id: "app.tree.filter.default",
    keys: ["ctrl+d"],
    label: "恢复默认视图",
    description: "将树过滤设为默认视图",
    group: "树导航",
  },
  {
    id: "app.tree.filter.noTools",
    keys: ["ctrl+t"],
    label: "隐藏工具结果",
    description: "切换隐藏工具结果的树过滤",
    group: "树导航",
  },
  {
    id: "app.tree.filter.userOnly",
    keys: ["ctrl+u"],
    label: "仅显示用户消息",
    description: "切换仅显示用户消息的树过滤",
    group: "树导航",
  },
  {
    id: "app.tree.filter.labeledOnly",
    keys: ["ctrl+l"],
    label: "仅显示带标签条目",
    description: "切换仅显示带标签条目的树过滤",
    group: "树导航",
  },
  {
    id: "app.tree.filter.all",
    keys: ["ctrl+a"],
    label: "显示所有条目",
    description: "切换显示所有条目的树过滤",
    group: "树导航",
  },
  {
    id: "app.tree.filter.cycleForward",
    keys: ["ctrl+o"],
    label: "向前循环切换树过滤",
    description: "按默认→无工具→仅用户→仅标签→全部的顺序向前循环切换",
    group: "树导航",
  },
  {
    id: "app.tree.filter.cycleBackward",
    keys: ["shift+ctrl+o"],
    label: "向后循环切换树过滤",
    description: "按全部→仅标签→仅用户→无工具→默认的顺序向后循环切换",
    group: "树导航",
  },

  // ── 模型选择器 ────────────────────────────────────────
  {
    id: "app.models.save",
    keys: ["ctrl+s"],
    label: "保存当前模型选择",
    description: "将当前模型选择保存到设置",
    group: "模型选择器",
  },
  {
    id: "app.models.enableAll",
    keys: ["ctrl+a"],
    label: "启用全部模型",
    description: "启用全部模型（或匹配当前搜索的模型）",
    group: "模型选择器",
  },
  {
    id: "app.models.clearAll",
    keys: ["ctrl+x"],
    label: "清空全部模型",
    description: "清空全部模型（或匹配当前搜索的模型）",
    group: "模型选择器",
  },
  {
    id: "app.models.toggleProvider",
    keys: ["ctrl+p"],
    label: "切换当前提供商全部模型",
    description: "切换当前提供商下的全部模型",
    group: "模型选择器",
  },
  {
    id: "app.models.reorderUp",
    keys: ["alt+up"],
    label: "上移所选模型",
    description: "在循环顺序中上移所选模型",
    group: "模型选择器",
  },
  {
    id: "app.models.reorderDown",
    keys: ["alt+down"],
    label: "下移所选模型",
    description: "在循环顺序中下移所选模型",
    group: "模型选择器",
  },
];
