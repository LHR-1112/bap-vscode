// smoke.ts —— TS 侧对测试服务器验证 Java 桥（connect/call/ping/disconnect）。
// 用法：
//   BAP_URI='ws://175.178.82.117:2020' BAP_USER='root' BAP_PWD='<密码>' \
//   npx tsx packages/rpc/scripts/smoke.ts
import * as path from 'path';
import * as fs from 'fs';
import { createRpcClient } from '../src/index';
import type { BridgeLaunchConfig, SessionDto } from '../src/types';

async function main() {
  const uri = process.env.BAP_URI ?? 'ws://175.178.82.117:2020';
  const user = process.env.BAP_USER ?? 'root';
  const pwd = process.env.BAP_PWD ?? '';
  if (!pwd) {
    console.error('请设置 BAP_PWD 环境变量');
    process.exit(1);
  }

  // 开发期：直接指向 java-bridge 的 dist/lib（生产环境走 assets/bridge/lib，由 apps/vscode 组装）
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const distLib = path.join(repoRoot, 'packages', 'java-bridge', 'dist', 'lib');
  if (!fs.existsSync(distLib)) {
    console.error('未找到 java-bridge 构建产物: ' + distLib + '，请先运行 npm run build -w @bap/java-bridge');
    process.exit(1);
  }

  const launch: BridgeLaunchConfig = {
    classpath: [path.join(distLib, '*')],
    mainClass: 'com.bap.dev.BridgeMain',
  };
  const rpc = createRpcClient({ launch });

  rpc.onExit((code) => console.log(`[smoke] bridge exit code=${code}`));

  try {
    console.log(`[smoke] connect ${uri} as ${user} ...`);
    const session = await rpc.connect(uri, user, pwd);
    console.log('[smoke] connect OK:', JSON.stringify(session));
    if (session.userCode !== user) throw new Error(`session.userCode=${session.userCode} ≠ ${user}`);
    if (!session.userGid?.uuid) throw new Error('session.userGid.uuid 未解析');
    console.log('[smoke] session.userGid.uuid =', session.userGid.uuid);

    console.log('[smoke] call("getAllProjects") ...');
    const projects = await rpc.call<Array<{ name?: string; uuid?: string }>>('getAllProjects');
    console.log('[smoke] getAllProjects count =', projects.length);
    if (projects.length === 0) throw new Error('getAllProjects 返回空');

    console.log('[smoke] ping ...');
    const pong = await rpc.ping();
    if (pong !== true) throw new Error('ping != true');
    console.log('[smoke] ping OK');

    await rpc.disconnect();
    await rpc.close();
    console.log('SMOKE_OK');
  } catch (e: any) {
    console.error('[smoke] FAILED:', e?.code, e?.message);
    process.exit(1);
  }
}

main();
