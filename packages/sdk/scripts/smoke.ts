// smoke.ts —— SDK 对测试服务器做「只读」验证。
// 只测读路径（connect / getAllProjects / getProject / getFolders / refresh 空src），不 commit/publish，不污染云端。
// 用法：
//   BAP_URI='ws://175.178.82.117:2020' BAP_USER='root' BAP_PWD='<密码>' \
//   npx tsx packages/sdk/scripts/smoke.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRpcClient, type BridgeLaunchConfig } from '@bap/rpc';
import { createBapSdk } from '../src/index';

async function main() {
  const uri = process.env.BAP_URI ?? 'ws://175.178.82.117:2020';
  const user = process.env.BAP_USER ?? 'root';
  const pwd = process.env.BAP_PWD ?? '';
  if (!pwd) {
    console.error('请设置 BAP_PWD 环境变量');
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const distLib = path.join(repoRoot, 'packages', 'java-bridge', 'dist', 'lib');
  const launch: BridgeLaunchConfig = { classpath: [path.join(distLib, '*')], mainClass: 'com.bap.dev.BridgeMain' };

  // 阶段 A：拿一个真实工程 uuid
  let projectUuid: string;
  {
    const rpc = createRpcClient({ launch });
    await rpc.connect(uri, user, pwd);
    const projects = await rpc.call<Array<{ uuid: string; name: string }>>('getAllProjects');
    console.log('[smoke] getAllProjects count =', projects.length);
    if (!projects[0]) throw new Error('getAllProjects 空');
    projectUuid = projects[0].uuid;
    await rpc.close();
  }

  // 阶段 B：写 .develop（含真实 uuid），SDK 全流程
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-sdksmoke-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.develop'),
    `<properties><entry key="project">${projectUuid}</entry><entry key="uri">${uri}</entry><entry key="user">${user}</entry><entry key="pwd">${pwd}</entry></properties>`,
  );

  const rpc = createRpcClient({ launch });
  try {
    const sdk = createBapSdk({ rpc, workspaceRoot: root });

    const session = await sdk.login();
    console.log('[smoke] sdk.login() userCode =', session.session.userCode);

    const folders = await sdk.project.getFolders();
    console.log('[smoke] sdk.project.getFolders() count =', folders.length);

    const proj = await sdk.project.get();
    console.log('[smoke] sdk.project.get() name =', proj.name);

    const changes = await sdk.refresh();
    console.log('[smoke] sdk.refresh() changes (空src) =', changes.length);

    console.log('SMOKE_OK');
  } finally {
    await rpc.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
