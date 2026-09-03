// MCP host 端（运行于扩展宿主内）：启动本地 IPC server，注册 McpServerDefinitionProvider，
// 把 MCP 的 tool 调用转发为 bapIde.* 命令执行（严格命令映射）。
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { BAP_TOOLS, type IpTool } from './tools';

export const MCP_SERVER_ID = 'bap';

/** IPC 端点文件（供 Claude Code / Codex 拉起的 mcp-server 发现宿主端点）。 */
export const MCP_IPC_FILE = path.join(os.homedir(), '.bap', 'mcp-ipc');

/** 把端点写入 ~/.bap/mcp-ipc（每次激活覆盖）。 */
function writeIpcFile(endpoint: string): void {
  try {
    fs.mkdirSync(path.dirname(MCP_IPC_FILE), { recursive: true });
    fs.writeFileSync(MCP_IPC_FILE, endpoint, 'utf8');
  } catch {
    /* 写失败不影响 provider 注册 */
  }
}

/** 删除端点文件（宿主退出后端点已失效）。 */
function deleteIpcFile(): void {
  try {
    fs.rmSync(MCP_IPC_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

interface HostIpc {
  server: net.Server;
  token: string;
  sockets: Set<net.Socket>;
}

interface ToolDef { name: string; description?: string; inputSchema: Record<string, unknown>; }

/**
 * 注册 BAP 的 MCP server 定义。
 * 返回需 push 到 context.subscriptions 的 Disposable（注销 provider + 关闭 IPC server）。
 */
export function registerMcpServerProvider(
  context: vscode.ExtensionContext,
  log: { debug(msg: string): void; error(msg: string): void },
): Promise<vscode.Disposable> {
  const token = randomUUID();
  const ipc: HostIpc = { server: net.createServer(), token, sockets: new Set() };

  ipc.server.on('connection', (socket) => {
    ipc.sockets.add(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) void dispatch(socket, line, ipc, log);
      }
    });
    socket.on('close', () => ipc.sockets.delete(socket));
    socket.on('error', () => ipc.sockets.delete(socket));
  });

  return new Promise<vscode.Disposable>((resolvePromise) => {
    ipc.server.listen(0, '127.0.0.1', () => {
      const addr = ipc.server.address() as net.AddressInfo;
      const endpoint = `127.0.0.1:${addr.port}:${token}`;
      writeIpcFile(endpoint);

      const serverDef: vscode.McpStdioServerDefinition = new vscode.McpStdioServerDefinition(
        'BAP',
        process.execPath,
        [path.join(context.extensionPath, 'dist', 'mcp-server.js')],
        { BAP_IPC: endpoint },
      );

      const provider: vscode.McpServerDefinitionProvider = {
        provideMcpServerDefinitions: () => [serverDef],
        // 登录钩子：无 BAP 工程（无 .develop 工作区）则中止启动。
        resolveMcpServerDefinition: async (s) => {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!root || !fs.existsSync(path.join(root, '.develop'))) {
            log.debug('[mcp] 无 .develop，跳过 MCP server 启动');
            return undefined;
          }
          return s;
        },
      };

      const disp = vscode.lm.registerMcpServerDefinitionProvider(MCP_SERVER_ID, provider);
      log.debug(`[mcp] provider 就绪, ipc=${endpoint}`);
      resolvePromise({
        dispose: () => {
          disp.dispose();
          for (const s of ipc.sockets) { try { s.destroy(); } catch { /* ignore */ } }
          try { ipc.server.close(); } catch { /* ignore */ }
          deleteIpcFile();
        },
      });
    });
  });
}

async function dispatch(socket: net.Socket, line: string, ipc: HostIpc, log: { debug(msg: string): void; error(msg: string): void }): Promise<void> {
  let msg: { type?: string; id?: string; token?: string; name?: string; args?: Record<string, unknown> };
  try { msg = JSON.parse(line); } catch { return; }
  // 校验 token，仅接受持有 BAP_IPC token 的本地进程。
  if (msg.token !== ipc.token) { write(socket, { type: 'error', id: msg.id, error: 'unauthorized' }); return; }

  try {
    if (msg.type === 'listTools') {
      write(socket, { type: 'listTools', id: msg.id, tools: BAP_TOOLS.map(toToolDef) });
    } else if (msg.type === 'invoke') {
      const tool = BAP_TOOLS.find((t) => t.name === msg.name);
      if (!tool) { write(socket, { type: 'invoke', id: msg.id, error: `unknown tool: ${msg.name}` }); return; }
      const args = tool.toArgs ? tool.toArgs(msg.args ?? {}) : [];
      const result = await vscode.commands.executeCommand(tool.command, ...args);
      write(socket, { type: 'invoke', id: msg.id, result });
    } else {
      write(socket, { type: 'error', id: msg.id, error: `unknown request: ${msg.type}` });
    }
  } catch (e) {
    write(socket, { type: 'invoke', id: msg.id, error: e instanceof Error ? e.message : String(e) });
  }
  void log; // 预留：未来记录工具调用日志
}

function toToolDef(t: IpTool): ToolDef {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

function write(socket: net.Socket, obj: unknown): void {
  socket.write(JSON.stringify(obj) + '\n');
}
