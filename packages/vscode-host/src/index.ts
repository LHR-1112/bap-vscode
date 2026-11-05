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

export {
  DEVELOP_MARKER,
  VF_WORKSPACE_FILE,
  VF_DIR,
  scanBackendProjectRoots,
  isBackendProjectRoot,
  isVfWorkspaceRoot,
  sanitizeProjectDirName,
  resolveDownloadTargetDir,
  directoryHasEntries,
  validateDownloadTarget,
} from './backend-projects';
export type {
  BackendProjectRoot,
  ScanOptions,
  ValidateDownloadTargetOptions,
  DownloadTargetValidation,
} from './backend-projects';
export { discoverBackendProjects, discoverBackendProjectDescriptors } from './backend-projects-vscode';

// 多工程：发现 / 注册表 / 上下文 / 命令路由
export { activateBackendProjects } from './projects/activate';
export type { ActivateBackendProjectsOptions, ActivatedBackendProjects } from './projects/activate';
export { buildProjectDescriptors, discoverProjectDescriptors } from './projects/discovery';
export type { BackendProjectDescriptor } from './projects/discovery';
export { BackendProjectRegistry } from './projects/project-registry';
export type {
  ProjectRequest,
  ProjectResolution,
  ProjectPicker,
  ResolutionSource,
  ResolveOptions,
  ResolveManyOptions,
} from './projects/project-registry';
export { BackendProjectContext } from './projects/project-context';
export type { ProjectSdkHandle, BackendProjectContextOptions, IdentityCheck } from './projects/project-context';
export { RefreshScheduler } from './projects/refresh-scheduler';
export { ProjectResolutionError, isProjectResolutionError, formatCandidates } from './projects/project-errors';
export type { ProjectResolutionCode, ProjectCandidate } from './projects/project-errors';
export {
  pathKey,
  isSamePath,
  isPathInside,
  projectRelativePath,
  isInProjectSrc,
  isIgnoredProjectPath,
  deriveFullClass,
  normalizeServerUri,
  workspaceRelative,
} from './projects/project-paths';
export { readProjectIdentity, sameIdentity } from './projects/project-identity';
export type { ProjectIdentity } from './projects/project-identity';
export {
  computeProjectId,
  workspaceFolderSlug,
  assignUniqueDisplayNames,
  assignDuplicateFingerprints,
} from './projects/project-id';
export { registerProjectCommands } from './commands/command-router';
export type { ProjectCommandOptions } from './commands/command-router';

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
