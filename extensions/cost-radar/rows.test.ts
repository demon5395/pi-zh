import { describe, it, expect } from "vitest";
import { crossCwdCount, missingProviderCount, subagentRows } from "./rows";

const okUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const msg = (over: any = {}) => ({
  toolName: "subagent",
  details: {
    costContract: 1,
    results: [{ provider: "deepseek", model: "deepseek-v4-flash", usage: okUsage, endedAt: 111 }],
  },
  ...over,
});

describe("subagentRows", () => {
  it("合法：provider/model 归一 + endedAt 优先", () => {
    const rows = subagentRows(msg(), 999);
    expect(rows).toHaveLength(1);
    expect(rows[0].modelKey).toBe("deepseek/deepseek-v4-flash");
    expect(rows[0].tsMs).toBe(111);
    expect(rows[0].subagent).toBe(true);
    expect(rows[0].usage).toEqual(okUsage);
  });

  it("降级恒等性：非 subagent / 缺 costContract / results 非数组 → 空", () => {
    expect(subagentRows(msg({ toolName: "other" }), 1)).toEqual([]);
    expect(subagentRows({ toolName: "subagent", details: { results: [] } }, 1)).toEqual([]);
    expect(subagentRows({ toolName: "subagent", details: { costContract: 2, results: [] } }, 1)).toEqual([]);
    expect(subagentRows({ toolName: "subagent", details: { costContract: 1, results: {} } }, 1)).toEqual([]);
  });

  it("逐条校验：缺 provider / usage 非数 / 负值 → 跳过该条", () => {
    const m = {
      toolName: "subagent",
      details: {
        costContract: 1,
        results: [
          { model: "m", usage: okUsage },
          { provider: "p", model: "m", usage: { ...okUsage, input: NaN } },
          { provider: "p", model: "m", usage: { ...okUsage, output: -1 } },
          { provider: "p", model: "m", usage: okUsage },
        ],
      },
    };
    const rows = subagentRows(m, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].modelKey).toBe("p/m");
    expect(rows[0].tsMs).toBe(5); // 无 endedAt → 回落 entry ts
  });
});

describe("missingProviderCount", () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

  it("有正用量但缺 provider → 1；有 provider → 0；零用量 → 0", () => {
    expect(
      missingProviderCount({ toolName: "subagent", details: { results: [{ model: "m", usage }] } }),
    ).toBe(1);
    expect(
      missingProviderCount({ toolName: "subagent", details: { results: [{ provider: "p", model: "m", usage }] } }),
    ).toBe(0);
    expect(
      missingProviderCount({
        toolName: "subagent",
        details: { results: [{ model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
      }),
    ).toBe(0);
  });

  it("非法 usage / results 非数组 → 0", () => {
    expect(
      missingProviderCount({ toolName: "subagent", details: { results: [{ model: "m", usage: { input: NaN } }] } }),
    ).toBe(0);
    expect(missingProviderCount({ toolName: "subagent", details: { results: {} } })).toBe(0);
    expect(missingProviderCount({ toolName: "subagent", details: {} })).toBe(0);
  });

  it("逐条计数：同一结果集混合时只计缺 provider 且有正用量的条目", () => {
    expect(
      missingProviderCount({
        toolName: "subagent",
        details: {
          results: [
            { provider: "p", model: "m", usage },
            { model: "m", usage },
            { model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
            {}
          ],
        },
      }),
    ).toBe(1);
  });
});

describe("crossCwdCount（跨 cwd 未纳入共享闸门）", () => {
  const r = (cwd: unknown) => ({ provider: "p", model: "m", usage: okUsage, cwd });
  const withResults = (results: unknown[]) => ({
    toolName: "subagent",
    details: { costContract: 1, results },
  });

  it("cwd 与父会话不同 → 计数；相同 → 0", () => {
    expect(crossCwdCount(withResults([r("/child")]), "/parent")).toBe(1);
    expect(crossCwdCount(withResults([r("/parent")]), "/parent")).toBe(0);
  });

  it("路径归一：等价字面量（. / .. / 尾斜杠）不计数", () => {
    // 同一目录的不同字面量不得计为跨 cwd（path.resolve 归一后比较）
    expect(crossCwdCount(withResults([r("/a/../parent")]), "/parent")).toBe(0);
    expect(crossCwdCount(withResults([r("/parent/")]), "/parent")).toBe(0);
    expect(crossCwdCount(withResults([r("/./parent")]), "/parent")).toBe(0);
    expect(crossCwdCount(withResults([r("/parent")]), "/a/../parent")).toBe(0);
  });

  it("逐条计数：混合 cwd/相同/缺字段/非法类型", () => {
    expect(
      crossCwdCount(
        withResults([r("/a"), r("/parent"), r(undefined), r(123), {}]),
        "/parent",
      ),
    ).toBe(1);
  });

  it("降级：details 缺失 / results 非数组 / 空 cwd 字符串 → 0", () => {
    expect(crossCwdCount({ toolName: "subagent", details: {} }, "/parent")).toBe(0);
    expect(crossCwdCount({ toolName: "subagent", details: { results: {} } }, "/parent")).toBe(0);
    expect(crossCwdCount({ toolName: "subagent", details: { results: [r("")] } }, "/parent")).toBe(0);
  });

  it("C2 契约：缺 costContract（非 1）→ 忽略，不计数", () => {
    expect(
      crossCwdCount(
        { toolName: "subagent", details: { results: [r("/child")] } },
        "/parent",
      ),
    ).toBe(0);
  });
});
