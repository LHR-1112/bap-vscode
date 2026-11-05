// MCP 工具目录 / 模式裁剪 / 参数清洗 / envelope 单测（P1-7、P1-8）。
import { describe, it, expect } from 'vitest';
import {
  BAP_TOOLS,
  BOOTSTRAP_TOOL_NAMES,
  WORKSPACE_LEVEL_TOOL_NAMES,
  PROJECT_SCOPED_TOOL_NAMES,
  isProjectScopedTool,
  isWorkspaceLevelTool,
  toolsForMode,
  isToolAllowedInMode,
} from '../src/mcp/tools';
import { isToolCall, wrapProjectResult, type McpToolCtx } from '../src/mcp/tool-exec';

const props = (t: (typeof BAP_TOOLS)[number]): Record<string, unknown> =>
  (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
const required = (t: (typeof BAP_TOOLS)[number]): string[] =>
  ((t.inputSchema as { required?: string[] }).required ?? []) as string[];

describe('BAP_TOOLS 目录', () => {
  it('共 18 个工具，名称唯一', () => {
    expect(BAP_TOOLS).toHaveLength(18);
    expect(new Set(BAP_TOOLS.map((t) => t.name)).size).toBe(18);
  });

  it('15 个工程级工具带可选 project，且 project 不在 required', () => {
    expect(PROJECT_SCOPED_TOOL_NAMES).toHaveLength(15);
    for (const name of PROJECT_SCOPED_TOOL_NAMES) {
      const tool = BAP_TOOLS.find((t) => t.name === name)!;
      expect(props(tool)).toHaveProperty('project');
      expect(required(tool)).not.toContain('project');
      expect(isProjectScopedTool(name)).toBe(true);
      expect(isWorkspaceLevelTool(name)).toBe(false);
    }
  });

  it('3 个工作区级工具没有 project 参数', () => {
    expect([...WORKSPACE_LEVEL_TOOL_NAMES]).toEqual([
      'workspaceInfo',
      'listProjects',
      'downloadProject',
    ]);
    for (const name of WORKSPACE_LEVEL_TOOL_NAMES) {
      const tool = BAP_TOOLS.find((t) => t.name === name)!;
      expect(props(tool)).not.toHaveProperty('project');
      expect(isWorkspaceLevelTool(name)).toBe(true);
      expect(isProjectScopedTool(name)).toBe(false);
    }
  });

  it('引导模式只暴露 workspaceInfo / listProjects / downloadProject', () => {
    expect([...BOOTSTRAP_TOOL_NAMES]).toEqual([...WORKSPACE_LEVEL_TOOL_NAMES]);
    expect(toolsForMode('bootstrap').map((t) => t.name)).toEqual([...BOOTSTRAP_TOOL_NAMES]);
    expect(toolsForMode('full')).toHaveLength(18);
    for (const t of BAP_TOOLS) {
      expect(isToolAllowedInMode('full', t.name)).toBe(true);
      expect(isToolAllowedInMode('bootstrap', t.name)).toBe(
        (BOOTSTRAP_TOOL_NAMES as readonly string[]).includes(t.name),
      );
    }
  });

  it('未知工具名在两种模式下都不允许', () => {
    expect(isToolAllowedInMode('full', 'nope')).toBe(false);
    expect(isToolAllowedInMode('bootstrap', 'nope')).toBe(false);
  });
});

describe('toArgs 参数清洗', () => {
  it('保留 project，剔除内部路由键', () => {
    const refresh = BAP_TOOLS.find((t) => t.name === 'refresh')!;
    const args = refresh.toArgs({
      project: 'p1',
      __projectId: 'evil',
      __project: 'evil',
      projectId: 'evil',
      projectRoot: '/evil',
      pid: 'x',
      extra: 1,
    });
    expect(args).toEqual([{ __tool: true, project: 'p1', extra: 1 }]);
  });

  it('内部路由键 __tool 不会覆盖标记', () => {
    const commit = BAP_TOOLS.find((t) => t.name === 'commit')!;
    expect(commit.toArgs({ __tool: false, comment: 'c' })).toEqual([
      { __tool: true, comment: 'c' },
    ]);
  });
});

describe('isToolCall', () => {
  it('只认 __tool === true（不再接受字符串 "true"）', () => {
    expect(isToolCall({ __tool: true })).toBe(true);
    expect(isToolCall({ __tool: 'true' })).toBe(false);
    expect(isToolCall({ __tool: false })).toBe(false);
    expect(isToolCall({})).toBe(false);
    expect(isToolCall(null)).toBe(false);
    expect(isToolCall('x')).toBe(false);
  });
});

describe('wrapProjectResult', () => {
  const ctx = {
    workspaceRoot: '/w/p1',
    projectId: 'w-abc:p1',
    displayName: 'p1',
  } as McpToolCtx;

  it('包一层 project 身份', () => {
    expect(wrapProjectResult(ctx, { ok: 1 })).toEqual({
      project: { projectId: 'w-abc:p1', displayName: 'p1', root: '/w/p1' },
      result: { ok: 1 },
    });
  });

  it('undefined 结果转 null', () => {
    expect(wrapProjectResult(ctx, undefined).result).toBeNull();
  });

  it('缺少 projectId/displayName 时回退到路径', () => {
    expect(wrapProjectResult({ workspaceRoot: '/w/p1' } as McpToolCtx, 1).project).toEqual({
      projectId: '/w/p1',
      displayName: '/w/p1',
      root: '/w/p1',
    });
  });
});
