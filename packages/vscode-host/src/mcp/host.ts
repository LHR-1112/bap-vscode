// MCP host 端（运行于扩展宿主内）：启动本地 IPC server，注册 McpServerDefinitionProvider，
// 把 MCP 的 tool 调用转发为 bapIde.* 命令执行（严格命令映射）。
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { BAP_TOOLS, isToolAllowedInMode, toolsForMode, type IpTool } from './tools';
import {
  computeMcpMode,
  effectiveMcpMode,
  shouldStartMcp,
  type McpMode,
} from './mode';
import { isIpcToolError, toIpcToolError, type IpcToolError } from './ipc-protocol';
import { discoverBackendProjects } from '../backend-projects-vscode';

export const MCP_SERVER_ID = 'bap';

/** IPC 端点文件（供 Claude Code / Codex 拉起的 mcp-server 发现宿主端点）。 */
export const MCP_IPC_FILE = path.join(os.homedir(), '.bap', 'mcp-ipc');

export interface McpServerProviderOptions {
  /** 激活期注册的后端工程数（引导模式判定用）。 */
  getRegisteredProjectCount?: () => number;
}

/** 把端点写入 ~/.bap/mcp-ipc（每次激活覆盖）。 */
function writeIpcFile(endpoint: string): void {
  try {
    fs.mkdirSync(path.dirname(MCP_IPC_FILE), { recursive: true });
    fs.writeFileSync(MCP_IPC_FILE, endpoint, 'utf8');
  } catch {
    /* 写失败不影响 provider 注册 */
  }
}

/** 仅当端点文件仍是本窗口写入的内容时才删除（避免误删其它窗口的端点）。 */
function deleteOwnIpcFile(endpoint: string): void {
  try {
    if (fs.readFileSync(MCP_IPC_FILE, 'utf8').trim() !== endpoint) return;
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

interface DispatchState {
  /**
   * 每个 MCP 进程（一条 IPC 连接）首次请求工具列表时固定的模式。
   * 工具列表在进程启动时固定，外部客户端（Claude Code/Codex）不经过 VS Code 的
   * resolveMcpServerDefinition，因此不能使用宿主全局模式。
   */
  modes: WeakMap<net.Socket, McpMode>;
  /** 最近一次观察到的实时模式/工程集合，用于 .develop 变化提示。 */
  lastSeenLiveMode: McpMode;
  lastSeenProjectIds: string;
}

interface ToolDef { name: string; description?: string; inputSchema: Record<string, unknown>; }

type Logger = { debug(msg: string): void; error(msg: string): void };

/**
 * 注册 BAP 的 MCP server 定义。
 * 返回需 push 到 context.subscriptions 的 Disposable（注销 provider + 关闭 IPC server）。
 */
export function registerMcpServerProvider(
  context: vscode.ExtensionContext,
  log: Logger,
  options: McpServerProviderOptions = {},
): Promise<vscode.Disposable> {
  const token = randomUUID();
  const ipc: HostIpc = { server: net.createServer(), token, sockets: new Set() };
  const getRegisteredCount = (): number => options.getRegisteredProjectCount?.() ?? 0;
  const liveMode = (): McpMode =>
    computeMcpMode(getRegisteredCount(), discoverBackendProjects().length);
  const liveProjectIds = (): string =>
    discoverBackendProjects()
      .map((d) => d.realRoot)
      .sort()
      .join('\n');
  const state: DispatchState = {
    modes: new WeakMap(),
    lastSeenLiveMode: liveMode(),
    lastSeenProjectIds: liveProjectIds(),
  };
  /** 当前连接实际生效的模式：首次请求时按实时状态固定，之后只允许因工程消失降级。 */
  const modeFor = (socket: net.Socket): McpMode => {
    const live = liveMode();
    const pinned = state.modes.get(socket);
    if (pinned === undefined) {
      state.modes.set(socket, live);
      return live;
    }
    return effectiveMcpMode(pinned, live);
  };

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
        if (line) void dispatch(socket, line, ipc, modeFor);
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
        // 启动门禁：窗口至少打开一个 workspace folder 才启动；完全无文件夹不启动。
        // 无 .develop 时以 bootstrap 模式启动，只暴露引导工具（P1-8）。
        resolveMcpServerDefinition: async (s) => {
          const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
          if (!shouldStartMcp(folderCount)) {
            log.debug('[mcp] 窗口没有 workspace folder，跳过 MCP server 启动');
            return undefined;
          }
          // 不在 resolve 时固定全局模式：外部客户端不经过此钩子，模式由各自 IPC 连接在
          // 首次 listTools/invoke 时按实时状态固定（见 modeFor）。
          const live = discoverBackendProjects().length;
          log.debug(
            `[mcp] resolve registered=${getRegisteredCount()} live=${live} liveMode=${liveMode()}`,
          );
          return s;
        },
      };

      const disp = vscode.lm.registerMcpServerDefinitionProvider(MCP_SERVER_ID, provider);

      // 监听 .develop 出现/消失：工程数变化时提示重载（工具列表在 MCP 进程启动时固定）。
      const watcher = vscode.workspace.createFileSystemWatcher('**/.develop');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onDevelopChange = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          // 用实时工程集合检测变化：不能拿被进程模式封顶的 effective 模式比较，
          // 否则「bootstrap 启动后出现 .develop」永远不会提示重载。
          const nextMode = liveMode();
          const nextIds = liveProjectIds();
          if (nextMode === state.lastSeenLiveMode && nextIds === state.lastSeenProjectIds) return;
          const nextCount = nextIds ? nextIds.split('\n').length : 0;
          // 只有最后一个工程被移除才会切回引导模式；多工程窗口移除其中一个仍是完整工具集。
          const hasProjects = nextCount > 0;
          state.lastSeenLiveMode = nextMode;
          state.lastSeenProjectIds = nextIds;
          void vscode.window
            .showInformationMessage(
              hasProjects
                ? 'BAP: 后端工程集合已变化。重新加载窗口后 MCP 工具集与 SCM 才会同步。'
                : 'BAP: 后端工程已移除。重新加载窗口后 MCP 会切换为引导模式。',
              '重新加载',
            )
            .then((a) => {
              if (a === '重新加载') void vscode.commands.executeCommand('workbench.action.reloadWindow');
            });
        }, 800);
      };
      watcher.onDidCreate(onDevelopChange);
      watcher.onDidDelete(onDevelopChange);

      log.debug(`[mcp] provider 就绪, ipc=${endpoint}`);
      resolvePromise({
        dispose: () => {
          disp.dispose();
          watcher.dispose();
          if (timer) clearTimeout(timer);
          for (const s of ipc.sockets) { try { s.destroy(); } catch { /* ignore */ } }
          try { ipc.server.close(); } catch { /* ignore */ }
          deleteOwnIpcFile(endpoint);
        },
      });
    });
  });
}

async function dispatch(
  socket: net.Socket,
  line: string,
  ipc: HostIpc,
  modeFor: (socket: net.Socket) => McpMode,
): Promise<void> {
  let msg: { type?: string; id?: string; token?: string; name?: string; args?: Record<string, unknown> };
  try { msg = JSON.parse(line); } catch { return; }
  // 校验 token，仅接受持有 BAP_IPC token 的本地进程。
  if (msg.token !== ipc.token) { write(socket, { type: 'error', id: msg.id, error: 'unauthorized' }); return; }

  try {
    if (msg.type === 'listTools') {
      // 首次请求时固定该连接的进程模式（工具列表在 MCP 进程启动时固定）。
      write(socket, { type: 'listTools', id: msg.id, tools: toolsForMode(modeFor(socket)).map(toToolDef) });
    } else if (msg.type === 'invoke') {
      const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
      if (!shouldStartMcp(folderCount)) {
        write(socket, {
          type: 'invoke',
          id: msg.id,
          error: { message: '当前窗口没有打开工作区文件夹，MCP 工具不可用', code: 'NO_WORKSPACE' },
        });
        return;
      }
      const tool = BAP_TOOLS.find((t) => t.name === msg.name);
      if (!tool) {
        write(socket, {
          type: 'invoke',
          id: msg.id,
          error: { message: `unknown tool: ${msg.name}`, code: 'UNKNOWN_TOOL' },
        });
        return;
      }
      const mode = modeFor(socket);
      if (!isToolAllowedInMode(mode, tool.name)) {
        write(socket, {
          type: 'invoke',
          id: msg.id,
          error: {
            message:
              `当前 MCP 进程以引导模式启动（启动时未发现已注册的后端工程），只提供 workspaceInfo / listProjects / downloadProject；` +
              `请先下载工程并加入工作区、重新加载窗口后再调用 ${tool.name}`,
            code: 'BOOTSTRAP_MODE',
          },
        });
        return;
      }
      const args = tool.toArgs ? tool.toArgs(msg.args ?? {}) : [];
      // workspaceInfo 需要报告调用方进程实际生效的模式，而不是按当前状态重新推断。
      if (tool.name === 'workspaceInfo' && args[0] && typeof args[0] === 'object') {
        (args[0] as Record<string, unknown>).__mcpMode = mode;
      }
      const result = await vscode.commands.executeCommand(tool.command, ...args);
      // 命令的交互式错误约定是返回 { error }（不抛异常）；MCP 调用方需要真实错误。
      const cmdError = extractCommandError(result);
      if (cmdError) write(socket, { type: 'invoke', id: msg.id, error: cmdError });
      else write(socket, { type: 'invoke', id: msg.id, result });
    } else {
      write(socket, { type: 'error', id: msg.id, error: `unknown request: ${msg.type}` });
    }
  } catch (e) {
    write(socket, { type: 'invoke', id: msg.id, error: toIpcToolError(e) });
  }
}

function toToolDef(t: IpTool): ToolDef {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

/** 命令以 `{ error: string | IpcToolError }` 形式报告失败时，返回结构化错误。 */
function extractCommandError(result: unknown): IpcToolError | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const err = (result as { error?: unknown }).error;
  if (typeof err === 'string' && err) return { message: err };
  if (isIpcToolError(err)) return err;
  return undefined;
}

function write(socket: net.Socket, obj: unknown): void {
  socket.write(JSON.stringify(obj) + '\n');
}
