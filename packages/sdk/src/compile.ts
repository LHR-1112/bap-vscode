// 本地 javac 编译（复刻 bapdev-cli CompileHandler）：解析 .classpath 或约定布局，
// 编译 src/** → bin/，拷贝资源。不连服务器。
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export interface ProjectLayout {
  sourceRoots: string[];
  libraryFiles: string[];
  outputDir: string;
  classpathFile: string | null;
  mode: 'eclipse' | 'convention';
}

export interface CompileResult {
  success: boolean;
  compiledFiles: string[];
  copiedResourceFiles: string[];
  compilerOutput: string;
  sourceFiles: number;
  resourceFiles: number;
  outputDir: string;
  classpathMode: string;
  errorCode?: string;
}

const OUT_DEFAULT = 'bin';

// ---- 布局解析 ----

/** 解析 .classpath（Eclipse XML：kind=src/lib/output；忽略 con/var）。无 XML 依赖，用正则。 */
function parseClasspath(xml: string): { sources: string[]; libs: string[]; output: string } {
  const el = /<classpathentry\b([^>]*)\/>/g;
  const sources: string[] = [];
  const libs: string[] = [];
  let output = OUT_DEFAULT;
  let m: RegExpExecArray | null;
  while ((m = el.exec(xml)) !== null) {
    const attr = m[1] ?? '';
    const kind = /(?:^|\s)kind="([^"]*)"/.exec(attr)?.[1] ?? '';
    const p = /(?:^|\s)path="([^"]*)"/.exec(attr)?.[1] ?? '';
    if (!p) continue;
    if (kind === 'src') sources.push(p);
    else if (kind === 'lib') libs.push(p);
    else if (kind === 'output') output = p;
  }
  return { sources, libs, output };
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

/** 解析工程布局：优先 .classpath（≥1 个 src 目录），否则约定扫描。 */
export function resolveProjectLayout(workspaceRoot: string): ProjectLayout {
  const cpFile = path.join(workspaceRoot, '.classpath');
  const libDir = path.join(workspaceRoot, 'lib');
  const srcDir = path.join(workspaceRoot, 'src');

  if (fs.existsSync(cpFile)) {
    const parsed = parseClasspath(fs.readFileSync(cpFile, 'utf8'));
    if (parsed.sources.length > 0) {
      const sourceRoots = parsed.sources
        .map((s) => path.resolve(workspaceRoot, s))
        .filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
      const libraryFiles = parsed.libs
        .map((p) => path.resolve(workspaceRoot, p))
        .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      return {
        sourceRoots,
        libraryFiles,
        outputDir: path.resolve(workspaceRoot, parsed.output || OUT_DEFAULT),
        classpathFile: cpFile,
        mode: 'eclipse',
      };
    }
  }

  // 约定：src 子目录 + lib/** 递归 jar/zip + 输出 bin
  const sourceRoots: string[] = [];
  if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
    const children = fs
      .readdirSync(srcDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => path.join(srcDir, d.name));
    sourceRoots.push(...(children.length ? children : [srcDir]));
  }
  const libraryFiles = fs.existsSync(libDir)
    ? listFilesRecursive(libDir).filter((p) => {
        const n = p.toLowerCase();
        return n.endsWith('.jar') || n.endsWith('.zip');
      })
    : [];
  return {
    sourceRoots,
    libraryFiles,
    outputDir: path.resolve(workspaceRoot, OUT_DEFAULT),
    classpathFile: null,
    mode: 'convention',
  };
}

// ---- 收集源文件 ----

function collectSources(sourceRoots: string[]): { java: string[]; resources: string[] } {
  const java: string[] = [];
  const resources: string[] = [];
  for (const root of sourceRoots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    for (const abs of listFilesRecursive(root)) {
      if (abs.toLowerCase().endsWith('.java')) java.push(abs);
      else resources.push(abs);
    }
  }
  return { java, resources };
}

// ---- javac 定位 ----

function resolveJavac(jdkPath?: string): string {
  const bin = process.platform === 'win32' ? 'javac.exe' : 'javac';
  // 优先：设置项指定的 JDK 目录
  if (jdkPath && fs.existsSync(path.join(jdkPath, 'bin', bin))) return path.join(jdkPath, 'bin', bin);
  // 其次：JAVA_HOME
  const home = process.env.JAVA_HOME;
  if (home) {
    const p = path.join(home, 'bin', bin);
    if (fs.existsSync(p)) return p;
  }
  return bin;
}

/** 定位 java 命令（运行 JUnit 用）。优先 javaHome，其次 JAVA_HOME，最后 PATH。 */
export function resolveJava(jdkPath?: string): string {
  const bin = process.platform === 'win32' ? 'java.exe' : 'java';
  if (jdkPath && fs.existsSync(path.join(jdkPath, 'bin', bin))) return path.join(jdkPath, 'bin', bin);
  const home = process.env.JAVA_HOME;
  if (home) {
    const p = path.join(home, 'bin', bin);
    if (fs.existsSync(p)) return p;
  }
  return bin;
}

// ---- 资源拷贝 ----

function copyResources(resourceFiles: string[], outputDir: string, layout: ProjectLayout): string[] {
  const copied: string[] = [];
  for (const abs of resourceFiles) {
    let rel = path.basename(abs);
    let best: string | null = null;
    for (const root of layout.sourceRoots) {
      const r = path.resolve(root);
      if (abs === r || abs.startsWith(r + path.sep)) {
        if (!best || r.length > best.length) best = r;
      }
    }
    if (best) rel = path.relative(best, abs);
    const target = path.join(outputDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(abs, target);
    copied.push(abs);
  }
  return copied;
}

// ---- 编译 ----

export async function compileLocalProject(opts: {
  workspaceRoot: string;
  clean?: boolean;
  jdkPath?: string;
  onLog?: (msg: string) => void;
}): Promise<CompileResult> {
  const { workspaceRoot, clean, jdkPath, onLog } = opts;
  const layout = resolveProjectLayout(workspaceRoot);
  const outputDir = layout.outputDir;

  if (clean && fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const { java, resources } = collectSources(layout.sourceRoots);
  if (java.length === 0) {
    return { success: false, compiledFiles: [], copiedResourceFiles: [], compilerOutput: '', sourceFiles: 0, resourceFiles: resources.length, outputDir, classpathMode: layout.mode, errorCode: 'NO_SOURCE_FILES' };
  }

  const javac = resolveJavac(jdkPath);
  onLog?.(`编译项目（本地）… 源码 ${java.length} 个，javac=${javac}`);

  const classpathEntries = [outputDir, ...layout.libraryFiles];
  const args: string[] = ['-encoding', 'UTF-8', '-d', outputDir];
  args.push('-classpath', classpathEntries.join(path.delimiter));
  args.push(...java);

  const compilerOutput = await runJavac(javac, args);
  if (compilerOutput.exitCode !== 0) {
    return { success: false, compiledFiles: java, copiedResourceFiles: [], compilerOutput: compilerOutput.stderr, sourceFiles: java.length, resourceFiles: resources.length, outputDir, classpathMode: layout.mode, errorCode: 'COMPILE_FAILED' };
  }

  const copiedResourceFiles = copyResources(resources, outputDir, layout);
  return { success: true, compiledFiles: java, copiedResourceFiles, compilerOutput: compilerOutput.stderr, sourceFiles: java.length, resourceFiles: copiedResourceFiles.length, outputDir, classpathMode: layout.mode };
}

function runJavac(javac: string, args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(javac, args, { maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolve({ exitCode: err ? (err.code === 'ENOENT' ? 127 : 1) : 0, stderr: String(stderr ?? '') });
    });
  });
}
