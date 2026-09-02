// MCP 工具清单：宿主侧唯一权威，定义「一个 MCP tool ↔ 一个 bapIde.* 命令」的映射。
// tool 输入用 JSON Schema（MCP 规范）；toArgs 把 MCP 参数对象转为命令实参（{__tool:true,...}）。
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
// 每个工具：tool 名、对 AI 的描述、JSON Schema、落地命令、参数映射（只透传 __tool + 字段）
const T = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  command: string,
): IpTool => ({ name, description, inputSchema, command, toArgs: (a) => [{ __tool: true, ...a }] });

export const BAP_TOOLS: IpTool[] = [
  T('refresh', '比对本地与云端，重新计算变更列表（新增/修改/删除），返回非 NORMAL 变更数。', obj({}), 'bapIde.scm.refresh'),
  T('commit', '提交全部变更到云端。', obj({ comment: S('提交说明') }), 'bapIde.scm.commit'),
  T('commitFile', '提交单个文件到云端。', obj({ fullClass: S('Java 点分全类名'), path: S('资源相对 src/res 路径'), comment: S('提交说明') }), 'bapIde.scm.commitFile'),
  T('updateFile', '更新单个文件：从云端拉最新覆盖本地（回退到云端）。', obj({ fullClass: S('Java 点分全类名'), path: S('资源相对 src/res 路径') }), 'bapIde.scm.updateFile'),
  T('updateAll', '更新全部变更：全部回退到云端，删除本地新增。', obj({}), 'bapIde.scm.updateAll'),
  T('publish', '发布插件（全量）到所有用户。', obj({ ignoreErrors: B('编译有错仍发布') }), 'bapIde.scm.publish'),
  T('projectHistory', '项目历史版本列表。', obj({}), 'bapIde.scm.projectHistory'),
  T('fileHistory', '某个文件的历史版本。', obj({ remoteKey: S('资源相对路径 或 Java 点分全类名') }, ['remoteKey']), 'bapIde.scm.fileHistory'),
  T('updateLibs', '同步依赖 <工程>/lib 到云端（md5 比对增量更新）。', obj({}), 'bapIde.scm.updateLibs'),
  T('compileProject', '本地编译工程（javac src/** → bin/）。', obj({ clean: B('编译前清理') }), 'bapIde.scm.compileProject'),
  T('compileFile', '云端编译单个 Java 类，返回诊断。', obj({ fullClass: S('点分全类名'), code: S('源码') }, ['fullClass', 'code']), 'bapIde.scm.compileFile'),
  T('debugClass', '把单个类放云端运行，返回结果。', obj({ fullClass: S('点分全类名'), code: S('源码') }, ['fullClass', 'code']), 'bapIde.scm.debugClass'),
  T('testProject', '本地编译并运行单元测试。', obj({ selectClass: S('只跑指定类') }), 'bapIde.scm.testProject'),
  T('redirect', '把当前工程重定向到另一 BAP 服务器。', obj({ uri: S('ws 地址'), user: S('账号'), pwd: S('密码'), projectUuid: S('目标工程'), projectName: S('目标工程名') }, ['uri', 'user', 'pwd', 'projectUuid']), 'bapIde.scm.redirect'),
  T('downloadProject', '连接服务器并下载 BAP 工程到工作区。', obj({ uri: S('ws 地址'), user: S('账号'), pwd: S('密码'), projectUuid: S('工程 ID') }, ['uri', 'user', 'pwd', 'projectUuid']), 'bapIde.downloadProject'),
  T('listProjects', '登录后列出当前环境可操作的项目列表。', obj({ uri: S('ws 地址，缺省用当前连接'), user: S('账号'), pwd: S('密码') }), 'bapIde.listProjects'),
  T('fetchCurrent', '获取云端当前某个文件的内容。', obj({ fullClass: S('Java 点分全类名'), path: S('资源相对 src/res 路径') }), 'bapIde.fetchCurrent'),
];
