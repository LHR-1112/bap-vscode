// 单元测试：本地 JUnit 5（junit-platform-console-standalone）扫 bin/ + 项目 lib + BAP 连接属性。
// 依赖 sdk.compile.project() 先产出 bin/。
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface TestOptions {
  selectClass?: string;
  selectPackage?: string;
  method?: string;
  onOutput?: (line: string) => void;
}

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
}

/** 排除项目自带的 JUnit/hamcrest 等测试框架 jar（避免与标准 JUnit 冲突）。 */
function shouldExcludeLib(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes('junit') ||
    n.includes('hamcrest') ||
    n.includes('opentest4j') ||
    n.includes('apiguardian')
  );
}

/** 过滤噪音行（netty DEBUG、cell 加载列表等），避免刷屏淹没真实结果。 */
function isNoise(line: string): boolean {
  if (!line.trim()) return true;
  if (/DEBUG\s+io\.netty/.test(line)) return true;
  if (line.includes('[CRPC Connection')) return true;
  if (line.includes('Start loading local debugger')) return true;
  if (line.includes('Finish load all cells')) return true;
  if (line.includes('Thanks for using JUnit')) return true;
  if (line.includes('WARNING: Delegated to the')) return true;
  return line.length > 600; // 超长 cell 列表
}

/** 运行单元测试（到 junit-platform-console-standalone）。 */
export function runUnitTests(opts: {
  workspaceRoot: string;
  binDir: string;
  libFiles: string[];
  junitJarPath: string;
  javaBin: string;
  bapProps: Record<string, string>;
  test?: TestOptions;
  onLog?: (msg: string) => void;
}): Promise<TestResult> {
  const { workspaceRoot, binDir, libFiles, junitJarPath, javaBin, bapProps, test, onLog } = opts;
  const classpath = [
    binDir,
    ...libFiles.filter((f) => !shouldExcludeLib(path.basename(f))),
    junitJarPath,
  ].join(path.delimiter);

  const args = ['-cp', classpath];
  for (const [k, v] of Object.entries(bapProps)) args.push(`-D${k}=${v}`);
  args.push('org.junit.platform.console.ConsoleLauncher', '--details=summary');
  if (test?.selectClass) args.push('--select-class', test.selectClass);
  else if (test?.selectPackage) args.push('--select-package', test.selectPackage);
  else args.push('--scan-class-path', binDir);
  if (test?.method && test?.selectClass) args.push('--select-method', `${test.selectClass}#${test.method}`);

  onLog?.(`[test] 运行: ${javaBin} ${args.slice(0, 2).join(' ')} …`);

  return new Promise<TestResult>((resolve) => {
    const child = spawn(javaBin, args, { cwd: workspaceRoot });
    let stdout = '';
    const readline = require('readline');
    const outRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    outRl.on('line', (line: string) => {
      if (isNoise(line)) return;
      stdout += line + '\n';
      test?.onOutput?.(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const l of chunk.split(/\r?\n/)) {
        if (l.trim() && !isNoise(l)) {
          stdout += l + '\n';
          test?.onOutput?.(l);
        }
      }
    });
    child.on('error', (err) => {
      onLog?.(`[test] fork 失败: ${err.message}`);
      resolve({ total: 0, passed: 0, failed: 0, skipped: 0, exitCode: 2 });
    });
    child.on('close', (code) => {
      resolve(parseTestSummary(stdout, code ?? 0));
    });
  });
}

/** 从 ConsoleLauncher 输出解析汇总（兼容 'tests found: N' 与 '[ N ... ]' 两种格式）。 */
export function parseTestSummary(output: string, exitCode: number): TestResult {
  const m = /tests found:\s*(\d+),\s*tests successful:\s*(\d+),\s*tests failed:\s*(\d+),\s*tests skipped:\s*(\d+)/.exec(output);
  if (m) {
    return {
      total: Number(m[1]) || 0,
      passed: Number(m[2]) || 0,
      failed: Number(m[3]) || 0,
      skipped: Number(m[4]) || 0,
      exitCode,
    };
  }
  // ConsoleLauncher 1.11 block 格式：[ N containers found ] / [ N tests successful ] 等
  const c = (label: string): number => {
    const r = new RegExp(`\\[\\s*(\\d+)\\s+${label}\\s*\\]`).exec(output);
    return r ? Number(r[1]) || 0 : 0;
  };
  const total = c('tests found') || c('tests discovered');
  if (total) {
    return {
      total,
      passed: c('tests successful'),
      failed: c('tests failed'),
      skipped: c('tests skipped'),
      exitCode,
    };
  }
  return { total: 0, passed: 0, failed: 0, skipped: 0, exitCode };
}

/** 确保 bin 目录存在（无则创建）。 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
