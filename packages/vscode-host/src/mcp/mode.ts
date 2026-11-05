// MCP 运行模式：full（完整工具集）/ bootstrap（无后端工程时仅引导工具）。
// 纯函数，便于单测；宿主与 mcp-server 共享同一判定语义。
export type McpMode = 'full' | 'bootstrap';

/** 窗口至少打开一个 workspace folder 才启动 MCP（完全无文件夹时不启动）。 */
export function shouldStartMcp(workspaceFolderCount: number): boolean {
  return workspaceFolderCount > 0;
}

/**
 * full 仅当「激活期已注册工程数 > 0」且「实时扫描到的工程数 > 0」。
 * 只看实时扫描不够：工程已下载但尚未加入工作区/重载时，仍应停留在 bootstrap。
 */
export function computeMcpMode(registeredProjectCount: number, liveProjectCount: number): McpMode {
  return registeredProjectCount > 0 && liveProjectCount > 0 ? 'full' : 'bootstrap';
}

/**
 * 服务进程启动时拉取的工具列表是固定的：一旦以 bootstrap 启动，
 * 即使当前窗口已具备 full 条件，也要等重载后才能扩展工具集。
 */
export function effectiveMcpMode(serverMode: McpMode | undefined, liveMode: McpMode): McpMode {
  return serverMode === 'full' && liveMode === 'full' ? 'full' : 'bootstrap';
}
