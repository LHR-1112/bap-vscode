// @bap/sdk —— 业务类型定义。
// 面向业务，不暴露 RPC。仅 type-only 引用 @bap/rpc 的 JsonValue/SessionDto。

import type { JsonValue, SessionDto } from '@bap/rpc';

export type Status = 'NORMAL' | 'MODIFIED' | 'ADDED' | 'DELETED_LOCALLY';

/** SDK 所需的 RPC 能力（结构接口，SDK 不持有具体类）。 */
export interface RpcInvoker {
  connect(uri: string, user: string, pwd: string): Promise<SessionDto>;
  call<T = JsonValue>(method: string, ...args: JsonValue[]): Promise<T>;
  disconnect(): Promise<void>;
  close(): Promise<void>;
}

/** .develop 配置。 */
export interface DevelopConfig {
  projectUuid: string;
  uri: string;
  user: string;
  pwd: string;
  adminTool?: string;
  localNioPort?: string;
}

/** 云端 Java 文件快照（FileDto 子集 + fullClass）。 */
export interface FileDto {
  path?: string;
  rootPath?: string;
  md5?: string;
  lastWriter?: string;
  flag?: number;
  size?: number;
  lastModify?: number;
  createTime?: number;
  extInfo?: string;
}

export interface JavaDto extends FileDto {
  fullClass?: string;
}

/** Java 代码（送服务端 CJavaCode 的 JSON 子集）。 */
export interface CJavaCode {
  uuid?: string;
  owner?: string;
  /** 保留但不指望穿透（桥 Gson 字段反射会丢弃 getter-only 的 projectUuid）。 */
  projectUuid?: string;
  mainClass: string;
  javaPackage: string;
  name?: string;
  code: string;
  fileEncoding?: string;
  lastWriter?: string;
  codeMd5?: string;
  saveTime?: number;
}

/** 资源文件（送服务端 CResFileDto 的 JSON 子集，fileBin 为 base64）。 */
export interface CResFileDto {
  uuid?: string;
  owner?: string;
  projectUuid?: string;
  filePackage: string;
  fileName: string;
  size: number;
  fileBin: string; // base64（Gson byte[] 传输）
  fileMd5?: string;
  fileEncoding?: string;
  lastWriter?: string;
}

export interface CJavaFolderDto {
  uuid: string;
  name: string;
}

export interface CJavaProjectDto {
  uuid: string;
  name: string;
  dependType?: number;
}

/** 提交包（与 Java CommitPackage 字段名一致）。 */
export interface CommitPackage {
  comments: string;
  mapFolder2Codes: Record<string, CJavaCode[]>;
  deleteCodeMap: Record<string, string[]>;
  mapFolder2Files: Record<string, CResFileDto[]>;
  deleteFileMap: Record<string, string[]>;
}

/** refresh 产出的单个变更。 */
export interface Change {
  /** 相对 <folder>/ 或 src/res/ 的路径，统一 '/'。 */
  relativePath: string;
  /** 本地绝对路径（DELETED_LOCALLY 时可能不存在）。 */
  absolutePath: string;
  /** src/<folder> 的 folder 名。 */
  folder: string;
  status: Status;
  isResource: boolean;
  fullClass?: string;
  md5: string;
}

/** code save 的装配结果。 */
export interface CommitResult {
  changes: Change[];
  pkg: CommitPackage;
}
