#!/usr/bin/env npx tsx
/**
 * check-coverage.ts — 检测 pi-zh COMMANDS 对 Pi 命令的覆盖率
 *
 * 用法：npx tsx scripts/check-coverage.ts
 * 退出码：0 = 全覆盖，1 = 有遗漏或解析失败
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Pi 命令全集（基于当前 Pi 版本，与 registerCommand() 调用保持同步）
// ============================================================
const PI_FULL_COMMANDS: string[] = [
  "login",
  "logout",
  "model",
  "settings",
  "scoped-models",
  "resume",
  "new",
  "name",
  "session",
  "tree",
  "trust",
  "fork",
  "clone",
  "compact",
  "copy",
  "export",
  "import",
  "share",
  "reload",
  "hotkeys",
  "changelog",
  "quit",
];

// ============================================================
// 主逻辑
// ============================================================
function main(): void {
  const extensionsDir = path.resolve(__dirname, "..", "extensions");
  const sourceFile = path.join(extensionsDir, "zh-commands.ts");

  // 1. 读取源文件
  if (!fs.existsSync(sourceFile)) {
    console.error(`❌ 找不到源文件: ${sourceFile}`);
    process.exit(1);
  }

  let source: string;
  try {
    source = fs.readFileSync(sourceFile, "utf-8");
  } catch (err) {
    console.error(`❌ 无法读取源文件: ${sourceFile}`);
    console.error(`   ${(err as Error).message}`);
    process.exit(1);
  }

  // 2. 从 COMMANDS 数组中提取所有 name 字段
  //    先截取 const COMMANDS = [...] 数组内容，再在区间内匹配 name，
  //    天然避免字符串（如 URL 中的 //）或注释等其他区域的干扰
  const commandsMatch = source.match(/const\s+COMMANDS[^=]*=\s*\[([\s\S]*?)\];/);
  if (!commandsMatch) {
    console.error("❌ 无法解析 COMMANDS 数组：找不到数组定义");
    process.exit(1);
  }
  const commandsBlock = commandsMatch[1];

  const namePattern = /\{\s*name\s*:\s*"([^"]+)"/g;
  const coveredCommands: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(commandsBlock)) !== null) {
    coveredCommands.push(match[1]);
  }

  if (coveredCommands.length === 0) {
    console.error("❌ 无法解析 COMMANDS 数组：未找到任何 name 字段");
    process.exit(1);
  }

  // 2.5 检测 COMMANDS 中的重复命令
  const seenNames = new Set<string>();
  for (const cmd of coveredCommands) {
    if (seenNames.has(cmd)) {
      console.warn(`⚠️  重复命令: /${cmd}（COMMANDS 中出现多次，建议去重）`);
    }
    seenNames.add(cmd);
  }

  // 3. 计算覆盖率
  const coveredSet = new Set(coveredCommands);
  const fullSet = new Set(PI_FULL_COMMANDS);

  const missing: string[] = [];
  for (const cmd of PI_FULL_COMMANDS) {
    if (!coveredSet.has(cmd)) {
      missing.push(cmd);
    }
  }

  const extra: string[] = [];
  for (const cmd of coveredCommands) {
    if (!fullSet.has(cmd)) {
      extra.push(cmd);
    }
  }

  // 4. 输出报告
  console.log("");
  console.log("🔍 pi-zh 命令覆盖率检测");
  console.log("=".repeat(40));
  console.log(`  已覆盖: ${coveredCommands.length}/${PI_FULL_COMMANDS.length}`);
  console.log("");

  if (extra.length > 0) {
    console.log(`⚠️  多余命令（Pi 中不存在，建议移除）：`);
    for (const cmd of extra.sort()) {
      console.log(`   - /${cmd}`);
    }
    console.log("");
  }

  if (missing.length > 0) {
    console.log(`❌ 遗漏命令（${missing.length} 条缺少中文说明）：`);
    for (const cmd of missing.sort()) {
      console.log(`   - /${cmd}`);
    }
    console.log("");
    console.log("💡 修复方法：在 extensions/zh-commands.ts 的 COMMANDS 数组中追加以上命令条目。");
    console.log("   每条格式：{ name: \"命令名\", label: \"中文标签\", description: \"说明\", examples: [\"用例\"] }");
    console.log("");
    process.exit(1);
  }

  // 5. 全部通过
  console.log("✅ 全部 Pi 命令均已覆盖中文说明！");
  console.log("");
  process.exit(0);
}

main();
