// 后端工程根定位的 VS Code 包装：从当前窗口的 workspace folders 出发扫描。
import * as vscode from 'vscode';
import {
  scanBackendProjectRoots,
  type BackendProjectRoot,
  type ScanOptions,
} from './backend-projects';
import {
  discoverProjectDescriptors,
  type BackendProjectDescriptor,
} from './projects/discovery';

/** 当前窗口内所有含 .develop 的后端工程根（0..N，已去重排序）。 */
export function discoverBackendProjects(options?: ScanOptions): BackendProjectRoot[] {
  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
  return scanBackendProjectRoots(folders, options);
}

/** 当前窗口内所有后端工程描述符（稳定 projectId / 展示名 / 身份）。 */
export function discoverBackendProjectDescriptors(options?: ScanOptions): BackendProjectDescriptor[] {
  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
  return discoverProjectDescriptors(folders, options);
}
