// @bap/sdk —— BAP SDK 业务层（面向业务，不暴露 RPC）。
// 读 .develop / refresh（MD5 对比）/ commit（CommitPackage 组装）/ 高层服务。

export { createBapSdk } from './services';
export type { BapSdk, BapSdkOptions } from './services';
export { loadDevelop, writeDevelop, SdkError } from './develop';
export {
  metadataConnect,
  metadataCall,
  listMetadataDomains,
  listMetadataFunctions,
  registerMetadataFunction,
  registerMetadataFunctions,
  validateMetadataDomainCode,
  METADATA_CONNECT_TIMEOUT_MS,
  METADATA_READ_TIMEOUT_MS,
  METADATA_REGISTER_TIMEOUT_MS,
  METADATA_PING_TIMEOUT_MS,
  METADATA_DISCONNECT_TIMEOUT_MS,
} from './metadata';
export { refreshChanges, isNoFolderException } from './refresh';
export { buildCommitPackage, commitCode, allocUuidWithUnderline } from './commit';
export { md5String, md5Bytes, looseMd5, computeJavaStatus, computeResourceStatus } from './status';
export { scanFolder, toFullClass, dirToPackage } from './file-scanner';
export { loadRelocateHistory, saveRelocateHistory, addRelocateHistory, removeRelocateHistory } from './relocate';
export { syncLibs, scanLibMd5, LIB_TIMEOUT_MS } from './libs';
export type { SyncProgress, SyncResult, LibMd5 } from './libs';
export { compileLocalProject, resolveProjectLayout, resolveJava } from './compile';
export type { ProjectLayout, CompileResult } from './compile';
export { buildDebugCode } from './debug';
export { runUnitTests, parseTestSummary } from './test';
export type { TestOptions, TestResult } from './test';
export { downloadProject, detectJdk8, writeJavaSettings, DOWNLOAD_TIMEOUT_MS } from './download';
export type { DownloadOptions, JavaSettingsResult } from './download';

export type {
  Status,
  RpcInvoker,
  DevelopConfig,
  DomainInfoDto,
  InputParamMeta,
  RuleFunctionMeta,
  RegisterFunctionResult,
  ListFunctionsResult,
  FileDto,
  JavaDto,
  CJavaCode,
  CResFileDto,
  CJavaFolderDto,
  CJavaProjectDto,
  CommitPackage,
  Change,
  CommitResult,
  VersionNode,
  LvProblem,
  DebugResult,
} from './types';
export type { RelocateProfile } from './relocate';
