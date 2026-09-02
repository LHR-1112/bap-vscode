// @bap/vscode-host —— VS Code 宿主（第四层）：SCM 桥接。
// 把 VS Code 原生 Source Control 视图接到 BAP 云端工程。
import * as vscode from 'vscode';
import type { BapSdk } from '@bap/sdk';
import { activateScm } from './activate';

export { activateScm };
export type { ActivateScmOptions } from './activate';
export { createBapScmProvider } from './scm/bap-scm-provider';
export type { BapScmProviderHandle, BapFileDecorationMap, BapScmProviderOptions } from './scm/bap-scm-provider';
export { registerOriginalProvider } from './scm/original-provider';
export { BapFileDecorationProvider, registerFileDecoration } from './scm/file-decoration';
export {
  fileDecoFor,
  scmDecoFor,
  relToFullClass,
  relToResPath,
  bapOriginalUriSpec,
  parseBapOriginalUri,
} from './scm/types';
export type { FileDecoSpec, ScmDecoSpec } from './scm/types';

export { registerHistoryContentProvider } from './history/history-provider';
export { openHistoryView, openHistoryDiff } from './history/history-view';
export { checkLatestRelease, isNewer, DEFAULT_FEED } from './update-check';
export type { UpdateInfo } from './update-check';

export { registerMcpServerProvider, MCP_SERVER_ID } from './mcp/host';
export type { IpTool } from './mcp/tools';
export { isToolCall, type ToolArg } from './mcp/tool-exec';
export { collectAgentProjectInfo, buildAgentFileContent } from './agent/agent-instructions';
export type { AgentProjectInfo } from './agent/agent-instructions';

// 便捷：给定 sdk 和 workspaceRoot 一次性激活（供 apps/vscode 调用）。
export async function activateBapScm(
  context: vscode.ExtensionContext,
  sdk: BapSdk,
  workspaceRoot: string,
): Promise<vscode.Disposable[]> {
  return activateScm(context, sdk, workspaceRoot);
}
