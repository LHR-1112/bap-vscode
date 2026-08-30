// @bap/sdk —— BAP SDK 业务层（面向业务，不暴露 RPC）。
// 读 .develop / refresh（MD5 对比）/ commit（CommitPackage 组装）/ 高层服务。

export { createBapSdk } from './services';
export type { BapSdk, BapSdkOptions } from './services';
export { loadDevelop, writeDevelop, SdkError } from './develop';
export { refreshChanges, isNoFolderException } from './refresh';
export { buildCommitPackage, commitCode, allocUuidWithUnderline } from './commit';
export { md5String, md5Bytes, looseMd5, computeJavaStatus, computeResourceStatus } from './status';
export { scanFolder, toFullClass, dirToPackage } from './file-scanner';
export { loadRelocateHistory, saveRelocateHistory, addRelocateHistory, removeRelocateHistory } from './relocate';

export type {
  Status,
  RpcInvoker,
  DevelopConfig,
  FileDto,
  JavaDto,
  CJavaCode,
  CResFileDto,
  CJavaFolderDto,
  CJavaProjectDto,
  CommitPackage,
  Change,
  CommitResult,
} from './types';
export type { RelocateProfile } from './relocate';
