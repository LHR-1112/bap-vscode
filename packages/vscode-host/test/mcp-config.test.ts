// mcp-config 合并函数单测。
import { describe, it, expect } from 'vitest';
import { mergeMcpJson, mergeCodexToml } from '../src/agent/mcp-config';

const PATH = '/ext/dist/mcp-server.js';

describe('mergeMcpJson', () => {
  it('无现有文件：生成仅含 bap 的配置', () => {
    const out = mergeMcpJson(undefined, PATH);
    const j = JSON.parse(out);
    expect(j.mcpServers).toEqual({ bap: { command: 'node', args: [PATH] } });
  });

  it('已有其它 server：保留并插入 bap', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'npx', args: ['x'] } } });
    const j = JSON.parse(mergeMcpJson(existing, PATH));
    expect(j.mcpServers.other).toEqual({ command: 'npx', args: ['x'] });
    expect(j.mcpServers.bap).toEqual({ command: 'node', args: [PATH] });
  });

  it('已有 bap：更新而不重复', () => {
    const existing = JSON.stringify({ mcpServers: { bap: { command: 'old', args: [] } } });
    const j = JSON.parse(mergeMcpJson(existing, PATH));
    expect(Object.keys(j.mcpServers)).toEqual(['bap']);
    expect(j.mcpServers.bap.args).toEqual([PATH]);
  });

  it('损坏的 JSON：重建', () => {
    const j = JSON.parse(mergeMcpJson('not json {{{', PATH));
    expect(j.mcpServers.bap.command).toBe('node');
  });
});

describe('mergeCodexToml', () => {
  it('无现有文件：追加 bap 块', () => {
    const out = mergeCodexToml(undefined, PATH);
    expect(out).toContain('[mcp_servers.bap]');
    expect(out).toContain(`args = ["${PATH}"]`);
  });

  it('已有其它 mcp_servers：保留并追加 bap', () => {
    const existing = '[mcp_servers.other]\ncommand = "npx"\n';
    const out = mergeCodexToml(existing, PATH);
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('command = "npx"');
    expect(out).toContain('[mcp_servers.bap]');
    // 只出现一次 bap 块
    expect(out.split('[mcp_servers.bap]').length - 1).toBe(1);
  });

  it('已有 bap 块：替换而非重复', () => {
    const existing = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.bap]',
      'command = "old"',
      '',
      '[mcp_servers.other]',
      'command = "npx"',
      '',
    ].join('\n');
    const out = mergeCodexToml(existing, PATH);
    expect(out.split('[mcp_servers.bap]').length - 1).toBe(1);
    expect(out).toContain(`args = ["${PATH}"]`);
    expect(out).not.toContain('command = "old"');
    // 块前后的内容都在
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain('[mcp_servers.other]');
    // bap 块之后接 other 块
    expect(out.indexOf('[mcp_servers.bap]')).toBeLessThan(out.indexOf('[mcp_servers.other]'));
  });

  it('Windows 反斜杠路径：JSON 转义仍为合法 TOML 字符串', () => {
    const win = 'C:\\ext\\dist\\mcp-server.js';
    const out = mergeCodexToml(undefined, win);
    expect(out).toContain(`args = ["C:\\\\ext\\\\dist\\\\mcp-server.js"]`);
  });
});
