// MCP server：宿主外独立进程（node mcp-server.js），由 VS Code 经 McpStdioServerDefinition 拉起。
// 用官方 @modelcontextprotocol/sdk 的 Server + StdioServerTransport 与 VS Code（MCP client）通信；
// 工具清单与执行都经本地 IPC 转发回扩展宿主（严格命令映射：tool → bapIde.* → executeCommand）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 端点解析：BAP_IPC 环境变量 → BAP_IPC_FILE → ~/.bap/mcp-ipc。 */
function resolveEndpoint(): string {
  if (process.env.BAP_IPC) return process.env.BAP_IPC;
  const file = process.env.BAP_IPC_FILE ?? path.join(os.homedir(), '.bap', 'mcp-ipc');
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (content) return content;
  } catch {
    /* ignore */
  }
  return '';
}

const BAP_IPC = resolveEndpoint();
const [IPC_HOST, IPC_PORT, IPC_TOKEN] = BAP_IPC.split(':');

interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function connectIpc(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(IPC_PORT), IPC_HOST ?? '127.0.0.1', () => resolve(sock));
    sock.on('error', reject);
  });
}

/** 一次 IPC 请求：回包带相同 id，超时兜底。 */
function rpc(sock: net.Socket, msg: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.off('data', onData); reject(new Error('IPC 超时')); }, timeoutMs);
    function onData(chunk: Buffer): void {
      for (const line of chunk.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(t); } catch { continue; }
        if (parsed.id !== id) continue;
        clearTimeout(timer);
        sock.off('data', onData);
        if (parsed.error) reject(new Error(String(parsed.error)));
        else resolve(parsed);
      }
    }
    sock.on('data', onData);
    sock.write(JSON.stringify({ token: IPC_TOKEN, ...msg, id }) + '\n');
  });
}

async function main(): Promise<void> {
  if (!BAP_IPC || !IPC_PORT) {
    console.error('[bap-mcp] 找不到宿主 IPC 端点（BAP_IPC / ~/.bap/mcp-ipc），退出');
    process.exit(1);
  }
  const sock = await connectIpc();

  const listResp = (await rpc(sock, { type: 'listTools' })) as { tools?: ToolDef[] };
  const tools = listResp.tools ?? [];

  const server = new Server({ name: 'bap', version: '1.0.3' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const resp = (await rpc(sock, { type: 'invoke', name, args })) as { result?: unknown };
      const text = typeof resp.result === 'string' ? resp.result : JSON.stringify(resp.result ?? 'ok');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[bap-mcp] ready, tools=${tools.length}`);
}

main().catch((e) => { console.error('[bap-mcp] 失败: ', e); process.exit(1); });
