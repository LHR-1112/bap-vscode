// 生成 Claude Code（.mcp.json）与 Codex（.codex/config.toml）的 MCP 配置（合并写入，纯函数便于单测）。
// 两份配置都只写 command + args（指向扩展的 dist/mcp-server.js）；端点经 ~/.bap/mcp-ipc 文件发现，
// 配置里不含 token，插件重载后无需修改。

const MCP_SERVER_NAME = 'bap';

/** 生成 Claude Code 的 bap server 条目。 */
function mcpJsonEntry(mcpServerPath: string): Record<string, unknown> {
  return { command: 'node', args: [mcpServerPath] };
}

/**
 * 合并写入 .mcp.json：保留已有其它 mcpServers，仅更新/插入 bap。
 * @param existing 现有文件内容（无文件传 undefined）
 */
export function mergeMcpJson(existing: string | undefined, mcpServerPath: string): string {
  let root: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    try {
      const parsed = JSON.parse(existing) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) root = parsed;
    } catch {
      // 损坏的 JSON：重建（丢失原有内容，但保证可写）
    }
  }
  const servers = (root.mcpServers ?? {}) as Record<string, unknown>;
  servers[MCP_SERVER_NAME] = mcpJsonEntry(mcpServerPath);
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + '\n';
}

/** 生成 Codex 的 [mcp_servers.bap] TOML 块。 */
function codexBlock(mcpServerPath: string): string[] {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    'command = "node"',
    `args = [${JSON.stringify(mcpServerPath)}]`,
  ];
}

/**
 * 合并写入 .codex/config.toml：已有 [mcp_servers.bap] 块则替换（TOML 不允许重复表），
 * 否则追加；其它内容不动。
 * @param existing 现有文件内容（无文件传 undefined）
 */
export function mergeCodexToml(existing: string | undefined, mcpServerPath: string): string {
  const block = codexBlock(mcpServerPath);
  const lines = existing && existing.trim() ? existing.split(/\r?\n/) : [];
  const headerRe = /^\[mcp_servers\.bap\]\s*$/;

  const start = lines.findIndex((l) => headerRe.test(l.trim()));
  if (start < 0) {
    // 追加：先剥掉尾部空行，再隔一行接块
    const trimmedLines = [...lines];
    while (trimmedLines.length && !trimmedLines[trimmedLines.length - 1].trim()) trimmedLines.pop();
    const base = trimmedLines.join('\n');
    return `${base}${base ? '\n\n' : ''}${block.join('\n')}\n`;
  }

  // 替换块：从 header 到下一个 [ 开头的行（不含）或文件尾
  let end = start + 1;
  while (end < lines.length) {
    const t = lines[end].trim();
    if (t.startsWith('[')) break;
    end++;
  }
  const out = [...lines.slice(0, start), ...block, ...lines.slice(end)];
  return out.join('\n').replace(/\n*$/, '\n');
}
