// MCP 工具清单：宿主侧唯一权威，定义「一个 MCP tool ↔ 一个 bapIde.* 命令」的映射。
// tool 输入用 JSON Schema（MCP 规范）；toArgs 把 MCP 参数对象转为命令实参（{__tool:true,...}）。
import type { McpMode } from './mode';

export interface IpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 对应要执行的 bapIde.* 命令。 */
  command: string;
  /** MCP 参数对象 → executeCommand(...args) 实参数组（首参带 __tool 标记）。 */
  toArgs: (args: Record<string, unknown>) => unknown[];
}

const obj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  ...(required.length ? { required } : {}),
});
const S = (d: string): Record<string, unknown> => ({ type: 'string', description: d });
const B = (d: string): Record<string, unknown> => ({ type: 'boolean', description: d });

/**
 * 路由保留字段：调用方若塞入这些字段一律丢弃，避免绕过命令路由把操作定向到别的工程。
 * 注意 `project` 是 P1-7 的公开业务参数，必须保留并交给命令路由，不能出现在这里。
 */
const ROUTING_KEYS = ['__tool', 'projectId', '__projectId', '__project', 'projectRoot', '__projectRoot', 'pid'];

function sanitizeArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const k of ROUTING_KEYS) delete out[k];
  return out;
}

// 每个工具：tool 名、对 AI 的描述、JSON Schema、落地命令、参数映射（只透传 __tool + 业务字段）
const T = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  command: string,
): IpTool => ({ name, description, inputSchema, command, toArgs: (a) => [{ __tool: true, ...sanitizeArgs(a) }] });

/** 工程级工具共用的 project 参数。 */
const P = S('目标工程：projectId / projectUuid（忽略大小写）/ 工程名；窗口内多工程时必填。可用 workspaceInfo 查询。');

export const BAP_TOOLS: IpTool[] = [
  T(
    'workspaceInfo',
    '列出窗口内 workspace folders、已发现的后端工程（projectId / 工程名 / 路径 / 云端 uuid）、MCP 模式与可用工具。多工程时先调用它获取 project 参数可用值；不返回任何密码。',
    obj({}),
    'bapIde.workspaceInfo',
  ),
  T('refresh', '比对本地与云端，重新计算变更列表（新增/修改/删除），返回非 NORMAL 变更数。', obj({ project: P }), 'bapIde.scm.refresh'),
  T('commit', '提交全部变更到云端。', obj({ project: P, comment: S('提交说明') }), 'bapIde.scm.commit'),
  T('commitFile', '提交单个文件到云端。', obj({ project: P, fullClass: S('Java 点分全类名'), path: S('资源相对 src/res 路径'), comment: S('提交说明') }), 'bapIde.scm.commitFile'),
  T('updateFile', '更新单个文件：从云端拉最新覆盖本地（回退到云端）。', obj({ project: P, fullClass: S('Java 点分全类名'), path: S('资源相对 src/res 路径') }), 'bapIde.scm.updateFile'),
  T('updateAll', '更新全部变更：全部回退到云端，删除本地新增。', obj({ project: P }), 'bapIde.scm.updateAll'),
  T('publish', '发布插件（全量）到所有用户。', obj({ project: P, ignoreErrors: B('编译有错仍发布') }), 'bapIde.scm.publish'),
  T('projectHistory', '项目历史版本列表。', obj({ project: P }), 'bapIde.scm.projectHistory'),
  T('fileHistory', '某个文件的历史版本。', obj({ project: P, remoteKey: S('资源相对路径 或 Java 点分全类名') }, ['remoteKey']), 'bapIde.scm.fileHistory'),
  T('updateLibs', '同步依赖 <工程>/lib 到云端（md5 比对增量更新）。', obj({ project: P }), 'bapIde.scm.updateLibs'),
  T('compileProject', '本地编译工程（javac src/** → bin/）。', obj({ project: P, clean: B('编译前清理') }), 'bapIde.scm.compileProject'),
  T('compileFile', '云端编译单个 Java 类，返回诊断。', obj({ project: P, fullClass: S('点分全类名'), code: S('源码') }, ['fullClass', 'code']), 'bapIde.scm.compileFile'),
  T('debugClass', '把单个类放云端运行，返回结果。', obj({ project: P, fullClass: S('点分全类名'), code: S('源码') }, ['fullClass', 'code']), 'bapIde.scm.debugClass'),
  T('testProject', '本地编译并运行单元测试。', obj({ project: P, selectClass: S('只跑指定类') }), 'bapIde.scm.testProject'),
  T('redirect', '把目标工程重定向到另一 BAP 服务器（改写 .develop 并重连刷新）。', obj({ project: P, uri: S('ws 地址'), user: S('账号'), pwd: S('密码'), projectUuid: S('目标工程'), projectName: S('目标工程名') }, ['uri', 'user', 'pwd', 'projectUuid']), 'bapIde.scm.redirect'),
  T(
    'downloadProject',
    '连接服务器并下载 BAP 工程到工作区（VotaForge 工作区默认落到 <工作区>/<工程名> 子目录）。无需 .develop 即可调用，是引导模式下的自举入口；下载后需加入工作区并重载，MCP 才扩展为完整工具集。',
    obj({ uri: S('ws 地址'), user: S('账号'), pwd: S('密码'), projectUuid: S('工程 ID'), projectName: S('工程名（可选，用于确定默认目录名）'), targetDir: S('相对工作区根的下载目录（可选，必须位于工作区内）') }, ['uri', 'user', 'pwd', 'projectUuid']),
    'bapIde.downloadProject',
  ),
  T(
    'listProjects',
    '登录后列出当前环境可操作的项目列表。有后端工程时复用其连接；没有 .develop 时必须同时提供 uri/user/pwd 直连服务器。',
    obj({ uri: S('ws 地址，缺省用当前连接'), user: S('账号'), pwd: S('密码') }),
    'bapIde.listProjects',
  ),
  T('fetchCurrent', '获取云端当前某个文件的内容。', obj({ project: P, fullClass: S('Java 点分全类名'), path: S('资源相对 src/res 路径') }), 'bapIde.fetchCurrent'),
];

/** 工作区级工具：不需要（也不接受）project，结果为原始值，不包 project envelope。 */
export const WORKSPACE_LEVEL_TOOL_NAMES = ['workspaceInfo', 'listProjects', 'downloadProject'] as const;

/** 引导模式只暴露这三个工具（P1-8）。 */
export const BOOTSTRAP_TOOL_NAMES: readonly string[] = WORKSPACE_LEVEL_TOOL_NAMES;

const WORKSPACE_LEVEL_SET = new Set<string>(WORKSPACE_LEVEL_TOOL_NAMES);

/** 工程级工具：结果包 { project, result }。 */
export const PROJECT_SCOPED_TOOL_NAMES: readonly string[] = BAP_TOOLS.map((t) => t.name).filter(
  (name) => !WORKSPACE_LEVEL_SET.has(name),
);

const PROJECT_SCOPED_SET = new Set<string>(PROJECT_SCOPED_TOOL_NAMES);

export function isProjectScopedTool(name: string): boolean {
  return PROJECT_SCOPED_SET.has(name);
}

export function isWorkspaceLevelTool(name: string): boolean {
  return WORKSPACE_LEVEL_SET.has(name);
}

/** 指定模式下可用的工具（full = 全部；bootstrap = 仅引导工具，按声明顺序）。 */
export function toolsForMode(mode: McpMode): IpTool[] {
  if (mode === 'full') return BAP_TOOLS;
  return BOOTSTRAP_TOOL_NAMES.map((name) => BAP_TOOLS.find((t) => t.name === name)).filter(
    (t): t is IpTool => !!t,
  );
}

export function isToolAllowedInMode(mode: McpMode, name: string): boolean {
  if (mode === 'full') return BAP_TOOLS.some((t) => t.name === name);
  return WORKSPACE_LEVEL_SET.has(name);
}
