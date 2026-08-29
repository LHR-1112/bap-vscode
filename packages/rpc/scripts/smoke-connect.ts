// 冒烟脚本：连真实/本地 BAP server，观察连接建立、心跳保活、断连重连。
// 用法：BAP_RPC_URL=ws://host:port npm run smoke:rpc   （默认 ws://127.0.0.1:2020）
import { RpcConnection } from '../src/index';

const url = process.env.BAP_RPC_URL ?? 'ws://127.0.0.1:2020';
const durationMs = Number(process.env.BAP_SMOKE_SECONDS ?? 15) * 1000;

const conn = new RpcConnection({ url });

conn.on('stateChange', (prev, next) => console.log(`[state] ${prev} -> ${next}`));
conn.on('connect', () => console.log(`[connect] connected to ${url}`));
conn.on('close', (info) =>
  console.log(
    `[close] code=${info.code} wasClean=${info.wasClean} initiatedByUs=${info.initiatedByUs} reason=${info.reason}`,
  ),
);
conn.on('error', (err) => console.log(`[error] ${err.code}: ${err.message}`));

console.log(`[smoke] connecting to ${url} for ${durationMs / 1000}s ...`);
conn.connect().catch((err: Error) => console.error(`[smoke] connect failed: ${err.message}`));

setTimeout(() => {
  console.log('[smoke] done, closing');
  conn.close();
  process.exit(0);
}, durationMs);
