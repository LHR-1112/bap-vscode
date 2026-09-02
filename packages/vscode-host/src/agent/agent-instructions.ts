// 生成 AGENTS.md / CLAUDE.md 的确定性工程信息与内容（复刻 bapdev-cli 的 agent-instructions）。
// 供「Reset Agent Instructions」命令：收集当前工程信息 → 拼装 markdown → 写入根目录 CLAUDE.md / AGENTS.md。
import * as fs from 'fs';
import * as path from 'path';

export interface AgentProjectInfo {
  projectName: string;
  directories: string[];
  classpathEntries?: { kind: string; path: string }[];
  jdkVersion?: string;
}

const DEFAULT_EXCLUDE_DIRS = new Set(['.git', '.bapdev-cli', '.opencode', 'node_modules', 'target', 'build']);
const GPF_DC_PREFIX = 'gpf_dc_';

/** 读取 Java .properties 文件 → Record。缺失/失败返回空对象。 */
function readProperties(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  try {
    for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const eq = line.indexOf('=');
      const colon = line.indexOf(':');
      const sep = eq < 0 ? colon : colon < 0 ? eq : Math.min(eq, colon);
      if (sep < 0) continue;
      const key = line.slice(0, sep).trim();
      let value = line.slice(sep + 1).trim();
      // 剥掉行尾注释，反转义常见转义
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash);
      value = value.replace(/\\:/g, ':').replace(/\\=/g, '=').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      if (key) out[key] = value;
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function collectAgentProjectInfo(outputDir: string): AgentProjectInfo {
  const classpathEntries = readClasspathEntries(outputDir);
  return {
    projectName: resolveProjectName(outputDir),
    directories: listTopLevelDirectories(outputDir),
    ...(classpathEntries ? { classpathEntries } : {}),
    jdkVersion: '1.8',
  };
}

export function buildAgentFileContent(info: AgentProjectInfo): string {
  const jdk = info.jdkVersion ?? '1.8';
  const lines: string[] = [
    '# AI 协作指南',
    '',
    '> 由 BAP IDE 生成，反映本插件的 MCP 工具与技能；可在其上补充项目专属规范。',
    '',
    '## 项目概述',
    '',
    `- 项目名称：${info.projectName}`,
    '- 产品：GPF',
    `- JDK 版本：JDK ${jdk}`,
    '',
    '## 云工程能力（MCP 工具）',
    '',
    '本插件通过 MCP server（id=`bap`）把云工程能力暴露为 AI 工具（严格映射：一 tool ↔ 一 `bapIde.*` 命令）：',
    '',
    '- `refresh` 刷新（对比本地/云端）',
    '- `commit` 提交全部 / `commitFile` 提交单文件',
    '- `updateFile` 更新文件(回退云端) / `updateAll` 更新全部',
    '- `publish` 发布插件(全量)',
    '- `projectHistory` 项目历史 / `fileHistory` 文件历史',
    '- `updateLibs` 同步依赖',
    '- `compileProject` 本地编译 / `compileFile` 云端编译单类',
    '- `debugClass` 云端调试 / `testProject` 单元测试',
    '- `redirect` 重定向 / `downloadProject` 下载工程',
    '- `listProjects` 项目列表 / `fetchCurrent` 取云端当前文件',
    '',
    '## 核心约束',
    '',
    '- MUST 使用 Java 8 兼容语法与 API。',
    '- MUST 优先遵循现有工程模式，不自行引入新的架构或依赖。',
    '- MUST 以最小改动完成任务，不重构无关代码。',
    '- MUST 在修改前先确认相关实现与依赖关系。',
    '- MUST 在完成后执行适用的编译或测试验证。',
    '- MUST NOT 自行新增 jar。',
    '- MUST NOT 使用 Maven/Gradle 代替 BAP 工程编译流程。',
    '',
    '## 修改原则',
    '',
    '- 只修改完成当前任务所需的最小范围。',
    '- 不得顺手重构无关代码。',
    '- 不得修改与任务无关的命名、格式或目录结构。',
    '- 除非用户明确要求，不改变现有公开接口。',
    '- 发现现有代码存在其他问题时，先说明，不自行扩大修改范围。',
    '',
    '## 目录结构',
    '',
  ];

  if (info.directories.length > 0) {
    for (const dir of info.directories) {
      lines.push(`- ${dir}/`);
    }
  } else {
    lines.push('- 未发现顶层源码目录（请人工确认）。');
  }

  lines.push(
    '',
    '## 技能入口',
    '',
    '- 本插件 MCP 技能：`bap-vscode-mcp`（`skill/bap-vscode-mcp`，说明如何调用上述 MCP 工具）',
    '- GPF 开发任务优先使用 `gpf-dev-orchestrator` 路由：规则函数 `gpf-rule-function`、HTTP 接口 `gpf-http-interface`、云 Cell `gpf-cloud-cell`、基础 API `gpf-api-call`。',
    '',
    '## 构建与编译',
    '',
    '- 本地编译：`BAP: Compile Project`（MCP `compileProject`），用 `bapIde.java8Path` 的 javac 编译 `src/**` → `bin/`，不依赖 `pom.xml`。',
    '- 云端编译单类：`BAP: Compile File`（MCP `compileFile`），提供 `fullClass` + `code`。',
  );

  if (info.classpathEntries && info.classpathEntries.length > 0) {
    const srcAndOutput = info.classpathEntries.filter((entry) => entry.kind === 'src' || entry.kind === 'output');
    for (const entry of srcAndOutput) {
      lines.push(`  - ${entry.kind}: ${entry.path}`);
    }

    const libEntries = info.classpathEntries.filter((entry) => entry.kind === 'lib');
    if (libEntries.length > 0) {
      const libDirs = [...new Set(libEntries.map((entry) => libParentDir(entry.path)))].sort();
      lines.push(`  - 依赖库：${libDirs.join('、')}（约 ${libEntries.length} 个 jar，按需查询）`);
    }
  }

  lines.push(
    '- 编译报错先看输出通道「BAP IDE」；依赖缺失先执行 `BAP: Update Libraries`（MCP `updateLibs`）。',
    '',
    '## 测试约定',
    '',
    '- 单元测试：`BAP: Run Unit Tests`（MCP `testProject`，可用 `selectClass` 指定单个类）。',
    '- 执行单元测试前会先本地编译（preflight compile），要求 `bin` 已编译、依赖完整。',
    '- 依赖 Cell 运行环境的测试类应继承 `SilentBapTester`，否则 `Cells.get(...)` 会因 Cell Factory 未初始化失败；默认 `fork` 模式更接近 IDE 运行方式。',
    '- 测试结果见 HTML 报告与 `report.json`。',
    '',
    '## 代码风格',
    '',
    '- 查询平台源码/接口定义/类签名/实现细节时，必须按以下固定顺序：',
    '  1. 优先查询 `gpf-api-call` 技能内已收录的源码快照与参考资料',
    '  2. 若 `gpf-api-call` 中没有，再查询工程依赖中 `gpf_dc` 前缀 jar 包对应的 Java 源码',
    '  3. 若前两者都没有，再查询 `openSource/` 目录下的 `src.zip`',
    '- 该顺序是固定约束，缺少依据时不得直接跳到低优先级源码来源。',
    '- 具体 Java 命名/导入/格式化/包路径约束，可用 AI init 补全。',
    '',
    '- 规则函数开发',
    '  - 接口必须继承 `CellIntf`',
    '  - 包名必须以 `cell.` 开头',
    '  - 必须补齐 `@ClassDeclare`、`@MethodDeclare`、`@InputDeclare`',
    '  - 环境变量按约定使用 `exampleValue`',
    '',
    '- HTTP 接口开发',
    '  - 接口定义类必须继承 `RequestMappingIntf`',
    '  - 必须补齐 `@ClassDeclare`、`@MethodDeclare`',
    '  - 参数必须在 `@MethodDeclare.inputs` 中声明',
    '  - 路径统一使用 `@RequestMapping`',
    '  - 未明确限定时，`method` 默认同时支持 `GET` 和 `POST`',
    '',
    '- 云服务开发',
    '  - 服务类按 Cell 体系开发',
    '  - 服务 Cell 继承服务型基类，资源 Cell 使用资源型基类',
    '  - 生命周期资源必须在启动/停止阶段显式管理',
    '  - 获取方式、线程模型和资源释放规则应与当前工程约定保持一致',
    '',
    '## 云工程协作规范',
    '',
    '- 首次操作：`BAP: Download Project`（MCP `downloadProject`）把工程拉到本地，连接配置写入 `.develop`。',
    '- 提交前先 `BAP: Refresh`（MCP `refresh`）看差异；提交用 `BAP: Commit`（`commit`）/ `BAP: Commit File`（`commitFile`）。',
    '- 查看云端当前代码用 `BAP: Fetch Current`（MCP `fetchCurrent`），勿用历史/下载代替。',
    '- 更新（回退云端）用 `BAP: Update File` / `BAP: Update All`（`updateFile`/`updateAll`），前先 `Refresh`，未知差异不要直接覆盖本地。',
    '- 切换服务器用 `BAP: Redirect`（MCP `redirect`）。',
    '- `.develop`（连接配置）与 `.vscode/` 是本地资料，不要提交。',
    '',
    '## 依赖管理',
    '',
    '- MUST NOT 在本地工程中自行引入新的 jar 包。',
    '- 确需新增依赖，MUST 先询问用户，由用户在云工程完成依赖添加。',
    '- 云工程依赖变更后，MUST 执行 `BAP: Update Libraries`（MCP `updateLibs`）更新本地 `lib/`。',
    '',
    '## 环境要求',
    '',
    `- JDK ${jdk}（由设置 \`bapIde.java8Path\` 指定）。`,
    '',
    '## 注意事项',
    '',
    '- 敏感信息不得写入源码或版本库。',
    '- 本地配置文件不应提交。',
    '- 不要绕过云工程依赖管理机制直接新增本地 jar。',
    '',
  );

  return lines.join('\n');
}

function resolveProjectName(outputDir: string): string {
  const cloudFile = path.join(outputDir, '.bapdev-cli', 'cloud.properties');
  const cloud = fs.existsSync(cloudFile) ? readProperties(cloudFile) : undefined;

  if (cloud?.projectName) {
    return stripGpfDcPrefix(cloud.projectName);
  }

  const developFile = path.join(outputDir, '.develop');
  if (fs.existsSync(developFile)) {
    const project = extractXmlAttribute(fs.readFileSync(developFile, 'utf8'), 'Project');
    if (project) {
      return stripGpfDcPrefix(project);
    }
  }

  if (cloud?.project) {
    return stripGpfDcPrefix(cloud.project);
  }

  return stripGpfDcPrefix(path.basename(outputDir));
}

function listTopLevelDirectories(outputDir: string): string[] {
  if (!fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !DEFAULT_EXCLUDE_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readClasspathEntries(outputDir: string) {
  const classpathFile = path.join(outputDir, '.classpath');
  if (!fs.existsSync(classpathFile)) return undefined;

  const content = fs.readFileSync(classpathFile, 'utf8');
  const entries: { kind: string; path: string }[] = [];
  const tagRegex = /<classpathentry\b([^>]*?)(?:\/>|>)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    const kind = extractXmlAttribute(match[1], 'kind');
    const entryPath = extractXmlAttribute(match[1], 'path');
    if ((kind === 'src' || kind === 'lib' || kind === 'output') && entryPath) {
      entries.push({ kind, path: entryPath });
    }
  }
  return entries.length > 0 ? entries : undefined;
}

function extractXmlAttribute(content: string, attr: string) {
  const match = content.match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`));
  return match?.[1];
}

function libParentDir(libPath: string): string {
  const slashIndex = libPath.lastIndexOf('/');
  return slashIndex >= 0 ? libPath.slice(0, slashIndex) : libPath;
}

function stripGpfDcPrefix(value: string) {
  return value.startsWith(GPF_DC_PREFIX) ? value.slice(GPF_DC_PREFIX.length) : value;
}
