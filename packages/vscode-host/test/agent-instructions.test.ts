// 生成的 CLAUDE.md / AGENTS.md 内容：多工程、引导模式、skill 安装与 vf 路由声明（P1-9/P1-12）。
import { describe, it, expect } from 'vitest';
import { buildAgentFileContent, type AgentProjectInfo } from '../src/agent/agent-instructions';

const info: AgentProjectInfo = {
  projectName: 'demo',
  directories: ['src', 'lib'],
  jdkVersion: '1.8',
};

describe('buildAgentFileContent', () => {
  it('列出 18 个 MCP 工具与 workspaceInfo', () => {
    const text = buildAgentFileContent(info);
    for (const name of [
      'workspaceInfo',
      'refresh',
      'commit',
      'downloadProject',
      'listProjects',
      'redirect',
      'compileProject',
      'testProject',
    ]) {
      expect(text).toContain(`\`${name}\``);
    }
    expect(text).toContain('18');
  });

  it('说明 project 参数、歧义候选与返回 envelope', () => {
    const text = buildAgentFileContent(info);
    expect(text).toContain('`project`');
    expect(text).toContain('AMBIGUOUS');
    expect(text).toContain('{ project: { projectId, displayName, root }, result }');
  });

  it('说明引导模式与重载限制', () => {
    const text = buildAgentFileContent(info);
    expect(text).toContain('引导模式');
    expect(text).toContain('`workspaceInfo`');
    expect(text).toContain('`listProjects`');
    expect(text).toContain('`downloadProject`');
    expect(text).toContain('重载窗口');
  });

  it('无 vf 上下文：给出 bundle 内 skill 路径', () => {
    const text = buildAgentFileContent(info);
    expect(text).toContain('skill/bap-vscode-mcp');
  });

  it('vf 上下文：写出安装路径与顶层 routing skill 声明', () => {
    const text = buildAgentFileContent(info, {
      vfRoot: '/vf',
      skillInstallPath: '/vf/.votaforge/skill/bap-vscode-mcp',
    });
    expect(text).toContain('/vf/.votaforge/skill/bap-vscode-mcp');
    expect(text).toContain('顶层 routing skill');
    expect(text).toContain('不修改 `votaforge.workspace.json`');
  });

  it('兄弟工程表包含当前工程标记与 projectId', () => {
    const text = buildAgentFileContent(info, {
      projectCount: 2,
      siblings: [
        { projectId: 'wf:p1', displayName: 'P1', root: '/wf/p1', current: true },
        { projectId: 'wf:p2', displayName: 'P2', root: '/wf/p2', current: false },
      ],
    });
    expect(text).toContain('| 工程名 | projectId | 路径 |');
    expect(text).toContain('**P1**（当前）');
    expect(text).toContain('`wf:p2`');
  });

  it('不再假设窗口只有一个工程', () => {
    const text = buildAgentFileContent(info, { projectCount: 3 });
    expect(text).toContain('0..N 个后端工程');
    expect(text).toContain('共有 3 个后端工程');
    expect(text).not.toContain('唯一工程');
  });

  it('提示 .mcp.json 可能不被 vf 根启动的客户端读取', () => {
    const text = buildAgentFileContent(info);
    expect(text).toContain('当前后端工程根');
    expect(text).toContain('从 VotaForge 根启动');
  });
});
