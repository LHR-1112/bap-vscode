// MCP server：宿主外独立进程（node mcp-server.js），由 VS Code 或外部 AI 客户端拉起。
// 用官方 @modelcontextprotocol/sdk 的 Server + StdioServerTransport 与 MCP 客户端通信；
// 工具清单与执行都经本地 IPC 转发回扩展宿主（严格命令映射：tool → bapIde.* → executeCommand）。
// 宿主 IPC 断开（如窗口重载）后会自动重连、重拉工具列表并发送 tools/list_changed，
// 外部客户端（Claude Code / Codex）无需重启即可拿到新工具集。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatIpcToolError,
  IpcToolCallError,
  ipcTimeoutForTool,
  isIpcToolError,
} from './ipc-protocol';

/** 端点文件：外部客户端靠它发现宿主端点；窗口重载后宿主会换端口并重写此文件。 */
const IPC_FILE = process.env.BAP_IPC_FILE ?? path.join(os.homedir(), '.bap', 'mcp-ipc');

interface IpcEndpoint {
  host: string;
  port: number;
  token: string;
}

interface IpcConn {
  sock: net.Socket;
  token: string;
}

interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function readEndpointFile(): string | undefined {
  try {
    const content = fs.readFileSync(IPC_FILE, 'utf8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 端点候选。重连必须优先重读端点文件（窗口重载后宿主换随机端口并重写文件）；
 * BAP_IPC 环境变量是 VS Code 拉起时注入的初始端点，作为兜底。
 */
function endpointCandidates(preferEnv: boolean): string[] {
  const env = process.env.BAP_IPC?.trim() || undefined;
  const file = readEndpointFile();
  const ordered = preferEnv ? [env, file] : [file, env];
  const out: string[] = [];
  for (const raw of ordered) {
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/** 端点格式：`host:port:token`（token 为 UUID，不含冒号）。 */
function parseEndpoint(raw: string): IpcEndpoint | undefined {
  const first = raw.indexOf(':');
  const second = raw.indexOf(':', first + 1);
  if (first <= 0 || second < 0) return undefined;
  const host = raw.slice(0, first);
  const port = Number(raw.slice(first + 1, second));
  const token = raw.slice(second + 1);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) return undefined;
  return { host, port, token };
}

function connectOnce(ep: IpcEndpoint): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(ep.port, ep.host);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('IPC 连接超时'));
    }, 5000);
    const onError = (e: Error): void => {
      clearTimeout(timer);
      reject(e);
    };
    sock.once('error', onError);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.off('error', onError);
      // 连接建立后的错误统一走 close：销毁 socket 让等待中的请求失败，再由上层重连。
      sock.on('error', () => { sock.destroy(); });
      resolve(sock);
    });
  });
}

/** 一次 IPC 请求：回包带相同 id，超时 / 断连兜底。 */
function rpc(
  c: IpcConn,
  msg: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const sock = c.sock;
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    function cleanup(): void {
      if (timer) clearTimeout(timer);
      sock.off('data', onData);
      sock.off('close', onClose);
    }
    function onData(chunk: Buffer): void {
      for (const line of chunk.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(t); } catch { continue; }
        if (parsed.id !== id) continue;
        cleanup();
        if (parsed.error) {
          if (isIpcToolError(parsed.error)) reject(new IpcToolCallError(parsed.error));
          else reject(new Error(String(parsed.error)));
        } else resolve(parsed);
      }
    }
    function onClose(): void {
      cleanup();
      reject(new Error('IPC 连接已断开'));
    }
    timer = setTimeout(() => { cleanup(); reject(new Error('IPC 超时')); }, timeoutMs);
    sock.on('data', onData);
    sock.on('close', onClose);
    sock.write(JSON.stringify({ token: c.token, ...msg, id }) + '\n');
  });
}

let conn: IpcConn | undefined;
let connecting: Promise<IpcConn> | undefined;
let reconnectTask: Promise<void> | undefined;
let tools: ToolDef[] = [];
let server: Server | undefined;

interface Opened {
  conn: IpcConn;
  tools: ToolDef[];
}

/** 依次尝试端点候选：连接 + 拉取工具列表，失败则换下一个。 */
async function connectAndList(preferEnv: boolean): Promise<Opened> {
  const candidates = endpointCandidates(preferEnv);
  if (candidates.length === 0) {
    throw new Error('找不到宿主 IPC 端点（BAP_IPC / ~/.bap/mcp-ipc）');
  }
  let lastErr: unknown;
  for (const raw of candidates) {
    const ep = parseEndpoint(raw);
    if (!ep) {
      lastErr = new Error(`IPC 端点格式不正确: ${raw.replace(/:[^:]*$/, ':***')}`);
      continue;
    }
    let sock: net.Socket | undefined;
    try {
      sock = await connectOnce(ep);
      const c: IpcConn = { sock, token: ep.token };
      const resp = (await rpc(c, { type: 'listTools' }, 30_000)) as { tools?: ToolDef[] };
      return { conn: c, tools: resp.tools ?? [] };
    } catch (e) {
      lastErr = e;
      try { sock?.destroy(); } catch { /* ignore */ }
    }
  }
  throw lastErr ?? new Error('找不到宿主 IPC 端点');
}

/** 断开后由 close 事件统一触发后台重连。 */
function attachConnection(c: IpcConn): void {
  c.sock.on('close', () => {
    if (conn === c) conn = undefined;
    scheduleReconnect();
  });
}

async function ensureConnection(preferEnv: boolean): Promise<IpcConn> {
  if (conn && !conn.sock.destroyed) return conn;
  if (!connecting) {
    connecting = (async () => {
      const opened = await connectAndList(preferEnv);
      const namesChanged =
        opened.tools.map((t) => t.name).join('\n') !== tools.map((t) => t.name).join('\n');
      tools = opened.tools;
      conn = opened.conn;
      attachConnection(opened.conn);
      // 工具集变化（如引导模式 → 完整工具集）时通知客户端重新拉取。
      if (namesChanged && server) {
        try { await server.sendToolListChanged(); } catch { /* 客户端不支持则忽略 */ }
      }
      console.error(`[bap-mcp] 已连接宿主 IPC，tools=${tools.length}`);
      return opened.conn;
    })().finally(() => { connecting = undefined; });
  }
  return connecting;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 工具调用前确保连接（最多等 ms，覆盖窗口重载的几秒空窗）。 */
async function ensureConnectionWithin(ms: number): Promise<IpcConn> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const c = await ensureConnection(false);
      if (!c.sock.destroyed) return c;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
    }
    if (Date.now() >= deadline) throw new Error('IPC 连接已断开');
    await sleep(1000);
  }
}

/** 后台重连：5 分钟内持续尝试，超时后等下次工具调用再试。 */
function scheduleReconnect(): void {
  if (reconnectTask) return;
  reconnectTask = (async () => {
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      try {
        const c = await ensureConnection(false);
        if (!c.sock.destroyed) return;
      } catch {
        /* 宿主未就绪，继续重试 */
      }
      if (Date.now() >= deadline) {
        console.error('[bap-mcp] 宿主 IPC 重连超时，将在下次工具调用时重试');
        return;
      }
      await sleep(1000);
    }
  })().finally(() => { reconnectTask = undefined; });
}

async function main(): Promise<void> {
  const opened = await connectAndList(true);
  conn = opened.conn;
  tools = opened.tools;

  server = new Server(
    { name: 'bap', version: '1.0.5' },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const c = await ensureConnectionWithin(30_000);
      const resp = (await rpc(
        c,
        { type: 'invoke', name, args },
        ipcTimeoutForTool(name),
      )) as { result?: unknown };
      const text = typeof resp.result === 'string' ? resp.result : JSON.stringify(resp.result ?? 'ok');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      const text = e instanceof IpcToolCallError
        ? formatIpcToolError(e.payload)
        : e instanceof Error
          ? e.message
          : String(e);
      return { content: [{ type: 'text', text }], isError: true };
    }
  });

  attachConnection(opened.conn);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[bap-mcp] ready, tools=${tools.length}`);
}

main().catch((e) => { console.error('[bap-mcp] 失败: ', e); process.exit(1); });
