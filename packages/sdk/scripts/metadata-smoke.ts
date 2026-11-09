// metadata-smoke.ts —— 真实服务器规则函数注册冒烟（默认只读）。
// 默认只做：connect → listDomains → listFunctions（只读），不写云端、不写 .develop。
// 受控写入必须显式 BAP_METADATA_WRITE=1，且只建议对测试工程/测试域执行。
//
// 凭据来源二选一：
//   A) 环境变量（注意：会进入 shell history/进程环境）：
//      BAP_URI='ws://...' BAP_USER='...' BAP_PWD='...' \
//        npx tsx packages/sdk/scripts/metadata-smoke.ts
//   B) 直接读某个真实工程的 .develop（推荐：密码不出现在命令行/终端）：
//      BAP_PROJECT_ROOT='/path/to/project' \
//        npx tsx packages/sdk/scripts/metadata-smoke.ts
//
// 可选：
//   BAP_DOMAIN='DOMAIN_CODE'          指定要 listFunctions 的域；缺省用 listDomains 的第一个
//   BAP_PROJECT_UUID='...'            环境变量模式下的工程 UUID（用于云端类/方法预检；缺省跳过）
//   BAP_METADATA_WRITE=1              开启受控写入
//   BAP_TEST_CLASS='com.x.TestRule'   写入目标类（全限定名）
//   BAP_TEST_METHOD='hello'           只注册单个方法；缺省注册整个类
//
// 安全约束：任何输出都不得包含密码；脚本只打印域 code/name、类名、方法名、计数与结果消息。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRpcClient, type BridgeLaunchConfig } from '@bap/rpc';
import {
  createBapSdk,
  loadDevelop,
  writeDevelop,
  SdkError,
  type DevelopConfig,
  type ListFunctionsResult,
  type RegisterFunctionResult,
} from '../src/index';

const PLACEHOLDER_PWD = 'smoke-placeholder-pwd';
const PLACEHOLDER_UUID = '00000000_0000_0000_0000_000000000000';

/** 当前密码（仅用于输出脱敏；不打印）。 */
let secret = '';
/** 环境变量模式下的临时工程目录（含 .develop），退出时清理。 */
let tmpRoot: string | undefined;
/** 当前桥客户端（Ctrl-C 时同步 kill，避免长注册期间遗留子进程）。 */
let activeRpc: { closeSync(): void } | undefined;
let cleanedUp = false;

/** 同步清理：kill 桥 + 删除含凭据的临时目录。幂等，信号处理与 exit 兜底共用。 */
function cleanupTemp(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    activeRpc?.closeSync();
  } catch {
    /* ignore */
  }
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpRoot = undefined;
  }
}

process.once('SIGINT', () => {
  cleanupTemp();
  process.exit(130);
});
process.once('SIGTERM', () => {
  cleanupTemp();
  process.exit(143);
});
process.on('exit', cleanupTemp);

function fail(msg: string): never {
  throw new Error(msg);
}

/** 输出前抹掉密码，避免远端异常消息意外回显。 */
function redact(text: string, pwd: string): string {
  if (!pwd) return text;
  return text.split(pwd).join('***');
}

/** 日志中的 URI 去掉 userinfo，避免 ws://user:pwd@host 把密码带进终端。 */
function redactUri(uri: string): string {
  return uri.replace(/\/\/[^/@]*@/, '//***@');
}

function printFunctions(label: string, result: ListFunctionsResult | RegisterFunctionResult): void {
  const list = result.functions ?? [];
  const total = 'totalCount' in result ? result.totalCount : undefined;
  console.log(`[metadata-smoke] ${label}: functions=${list.length} total=${total ?? '-'}`);
  for (const fn of list.slice(0, 10)) {
    const name = typeof fn.name === 'string' ? fn.name : '?';
    const ruleCode = typeof fn.ruleCode === 'string' ? fn.ruleCode : '-';
    const invoke = typeof fn.invokeMethod === 'string' ? fn.invokeMethod : '-';
    const codePath = typeof fn.codePath === 'string' ? fn.codePath : '-';
    console.log(`  - name=${name} ruleCode=${ruleCode} invokeMethod=${invoke} codePath=${codePath}`);
  }
  if (list.length > 10) console.log(`  ... 其余 ${list.length - 10} 个省略`);
}

async function main(): Promise<void> {
  const projectRoot = (process.env.BAP_PROJECT_ROOT ?? '').trim();
  let workspaceRoot = projectRoot ? path.resolve(projectRoot) : '';
  let cfg: Pick<DevelopConfig, 'uri' | 'user' | 'pwd'>;
  /** 是否有真实工程 UUID：决定写入前能否用 code.getRemote 做云端类/方法预检。 */
  let canPrecheckCloud = false;

  if (workspaceRoot) {
    if (!fs.existsSync(path.join(workspaceRoot, '.develop'))) {
      fail(`工程根目录缺少 .develop: ${workspaceRoot}`);
    }
    try {
      const d = loadDevelop(workspaceRoot);
      cfg = { uri: d.uri, user: d.user, pwd: d.pwd };
      canPrecheckCloud = !!d.projectUuid;
      console.log(`[metadata-smoke] 凭据来源: ${workspaceRoot}/.develop`);
      console.log(`[metadata-smoke] server=${redactUri(d.uri)}`);
    } catch (e) {
      fail(`读取 .develop 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    const uri = (process.env.BAP_URI ?? '').trim();
    const user = (process.env.BAP_USER ?? '').trim();
    const pwd = process.env.BAP_PWD ?? '';
    if (!uri || !user || !pwd) {
      fail('请设置 BAP_URI/BAP_USER/BAP_PWD，或设置 BAP_PROJECT_ROOT 指向含 .develop 的工程');
    }
    const projectUuid = (process.env.BAP_PROJECT_UUID ?? '').trim() || PLACEHOLDER_UUID;
    cfg = { uri, user, pwd };
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-metadata-smoke-'));
    workspaceRoot = tmpRoot;
    // 用 SDK 的 writeDevelop 写临时 .develop，避免手工拼接 XML 时凭据含 &/</entry> 被截断。
    writeDevelop(tmpRoot, { projectUuid, uri, user, pwd });
    try {
      fs.chmodSync(path.join(tmpRoot, '.develop'), 0o600);
    } catch {
      /* 权限收紧失败不阻断 smoke */
    }
    canPrecheckCloud = projectUuid !== PLACEHOLDER_UUID;
    console.log(`[metadata-smoke] 凭据来源: 环境变量 server=${redactUri(uri)}`);
    if (process.env.BAP_METADATA_WRITE === '1' && !canPrecheckCloud) {
      console.log('[metadata-smoke] 未提供 BAP_PROJECT_UUID，跳过云端类/方法预检（由服务器校验）');
    }
  }

  const pwd = cfg.pwd;
  secret = pwd;
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const distLib = path.join(repoRoot, 'packages', 'java-bridge', 'dist', 'lib');
  if (!fs.existsSync(path.join(distLib, 'bridge-main.jar'))) {
    fail(`未找到 java-bridge 构建产物: ${distLib}，请先运行 npm run build -w @bap/java-bridge`);
  }
  const launch: BridgeLaunchConfig = {
    classpath: [path.join(distLib, 'bridge-main.jar'), path.join(distLib, '*')],
    mainClass: 'com.bap.dev.BridgeMain',
  };
  const rpc = createRpcClient({ launch });
  activeRpc = rpc;
  rpc.onExit((code) => console.log(`[metadata-smoke] bridge exit code=${code}`));
  const sdk = createBapSdk({
    rpc,
    workspaceRoot,
    onLog: (m) => console.log('[sdk]', redact(m, pwd)),
  });

  try {
    console.log('[metadata-smoke] listDomains ...');
    const domains = await sdk.metadata.listDomains({ refresh: true });
    console.log(`[metadata-smoke] listDomains count=${domains.length}`);
    for (const d of domains.slice(0, 30)) {
      console.log(`  - domain=${d.code ?? '?'} name=${d.name ?? '-'}`);
    }
    if (domains.length > 30) console.log(`  ... 其余 ${domains.length - 30} 个省略`);

    const configured = sdk.metadata.configuredDomain();
    const domain = (process.env.BAP_DOMAIN ?? '').trim() || configured || domains[0]?.code?.trim() || '';
    if (!domain) {
      console.log('[metadata-smoke] 未发现可用业务域，跳过 listFunctions');
      console.log('SMOKE_OK');
      return;
    }
    console.log(`[metadata-smoke] 使用域: ${domain}${configured === domain ? '（来自 .develop 只读回退）' : ''}`);

    const listBefore = await sdk.metadata.listFunctions(domain);
    printFunctions('listFunctions(before)', listBefore);

    if (process.env.BAP_METADATA_WRITE !== '1') {
      console.log('[metadata-smoke] 只读模式完成（BAP_METADATA_WRITE != 1，未写入）');
      console.log('SMOKE_OK');
      return;
    }

    const testClass = (process.env.BAP_TEST_CLASS ?? '').trim();
    const testMethod = (process.env.BAP_TEST_METHOD ?? '').trim();
    if (!testClass) fail('写入模式必须设置 BAP_TEST_CLASS（全限定类名）');

    // 注册由服务端扫描云端源码完成；有真实工程 UUID 时先只读确认类/方法已在云端。
    if (canPrecheckCloud) {
      const remote = await sdk.code.getRemote(testClass);
      if (!remote) {
        fail(`云端未找到类 ${testClass}（未提交或类名错误），已跳过写入`);
      }
      console.log(`[metadata-smoke] 云端已确认类存在: ${testClass}`);
      if (testMethod) {
        if (typeof remote.code !== 'string' || !remote.code) {
          fail(`云端未返回类 ${testClass} 的源码，无法确认方法 ${testMethod}，已跳过写入`);
        }
        // 方法名可能是中文；\b 对中文不成立，用「非标识符字符」做前缀边界。
        const escaped = testMethod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const methodRe = new RegExp(`(?:^|[^\\w\\u4e00-\\u9fa5])${escaped}\\s*\\(`);
        if (!methodRe.test(remote.code)) {
          fail(`云端类 ${testClass} 中未找到方法 ${testMethod}，已跳过写入`);
        }
        console.log(`[metadata-smoke] 云端已确认方法存在: ${testMethod}`);
      }
    } else {
      console.log('[metadata-smoke] 无真实工程 UUID，跳过云端类/方法预检（由服务器校验）');
    }

    console.log(`[metadata-smoke] register ${testMethod ? `method=${testMethod}` : 'class'} class=${testClass} domain=${domain} ...`);
    const result = testMethod
      ? await sdk.metadata.registerFunction(domain, testClass, testMethod)
      : await sdk.metadata.registerFunctions(domain, testClass);
    console.log(`[metadata-smoke] register success=${result.success} message=${result.message ?? '-'}`);
    printFunctions('register.result', result);

    const listAfter = await sdk.metadata.listFunctions(domain);
    printFunctions('listFunctions(after)', listAfter);
    if (!result.success) {
      console.error(`[metadata-smoke] 注册未成功（success=false）：${result.message ?? '未知原因'}`);
      process.exitCode = 1;
      return;
    }
    console.log('SMOKE_OK');
  } finally {
    try {
      await sdk.disconnect();
    } catch {
      /* 未连接时会失败，忽略 */
    }
    try {
      await rpc.close();
    } catch {
      /* ignore */
    }
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  }
}

main().catch((e) => {
  const name = e instanceof SdkError ? e.code : e instanceof Error ? e.name : 'Error';
  const message = e instanceof Error ? e.message : String(e);
  // 输出前先按已知密码脱敏；main 后续未捕获异常也会经过这里。
  console.error(`[metadata-smoke] FAILED ${name}: ${redact(message, secret || process.env.BAP_PWD || PLACEHOLDER_PWD)}`);
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exitCode = 1;
});
