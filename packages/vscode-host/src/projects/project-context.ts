// 单个后端工程的运行时上下文：懒创建 SDK / SCM，串行化操作，写前校验工程身份。
import type { BapSdk } from '@bap/sdk';
import type { BapScmProviderHandle } from '../scm/bap-scm-provider';
import type { BackendProjectDescriptor } from './discovery';
import { ProjectResolutionError } from './project-errors';
import { readProjectIdentity, sameIdentity, type ProjectIdentity } from './project-identity';

export interface ProjectSdkHandle {
  sdk: BapSdk;
  /** 关闭该工程独占的 Java 桥（由宿主提供）。 */
  close?: () => Promise<void> | void;
}

export interface BackendProjectContextOptions {
  createSdk: (descriptor: BackendProjectDescriptor) => BapSdk | ProjectSdkHandle;
  createScm?: (context: BackendProjectContext, sdk: BapSdk) => BapScmProviderHandle;
  log?: { debug(msg: string): void; error(msg: string): void };
  onStale?: (context: BackendProjectContext, reason: string) => void;
}

export type IdentityCheck = 'same' | 'changed' | 'missing' | 'adopted';

/**
 * 工程上下文。
 * - SDK/RPC 首次被操作时才创建（某工程不打开就不启动 Java 桥）；
 * - 同一工程的命令串行执行（runExclusive），避免并发提交/刷新互相踩；
 * - 写操作前校验 `.develop` 身份，身份漂移则拒绝，防止写到别的云端工程。
 */
export class BackendProjectContext {
  readonly descriptor: BackendProjectDescriptor;
  private readonly options: BackendProjectContextOptions;
  private _sdk: BapSdk | undefined;
  private _closeSdk: (() => Promise<void> | void) | undefined;
  private _scm: BapScmProviderHandle | undefined;
  private _identity: ProjectIdentity | undefined;
  private _staleReason: string | undefined;
  private _disposed = false;
  private _shutdown: Promise<void> | undefined;
  private _tail: Promise<void> = Promise.resolve();

  constructor(descriptor: BackendProjectDescriptor, options: BackendProjectContextOptions) {
    this.descriptor = descriptor;
    this.options = options;
    this._identity = readProjectIdentity(descriptor.root);
  }

  get projectId(): string {
    return this.descriptor.projectId;
  }

  get root(): string {
    return this.descriptor.root;
  }

  get displayName(): string {
    return this.descriptor.displayName;
  }

  get identity(): ProjectIdentity | undefined {
    return this._identity;
  }

  get staleReason(): string | undefined {
    return this._staleReason;
  }

  get isStale(): boolean {
    return this._staleReason !== undefined;
  }

  get isDuplicateCheckout(): boolean {
    return !!this.descriptor.duplicateProjectUuid;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get sdk(): BapSdk | undefined {
    return this._sdk;
  }

  get scm(): BapScmProviderHandle | undefined {
    return this._scm;
  }

  ensureSdk(): BapSdk {
    this.assertUsable();
    if (!this._sdk) {
      const created = this.options.createSdk(this.descriptor);
      if (created && typeof created === 'object' && 'sdk' in created) {
        this._sdk = created.sdk;
        this._closeSdk = created.close;
      } else {
        this._sdk = created;
      }
      this.options.log?.debug(`[${this.displayName}] SDK 已创建`);
    }
    return this._sdk;
  }

  ensureScm(): BapScmProviderHandle {
    this.assertUsable();
    if (!this._scm) {
      if (!this.options.createScm) throw new Error('该上下文未配置 SCM 工厂');
      this._scm = this.options.createScm(this, this.ensureSdk());
      this.options.log?.debug(`[${this.displayName}] SCM provider 已创建`);
    }
    return this._scm;
  }

  /** 同一工程的异步操作串行执行；前一个失败不阻断后续。 */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.assertUsable();
    const run = this._tail.then(fn, fn);
    this._tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 写操作：身份校验 + 串行执行。 */
  async runWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.verifyIdentity();
    return this.runExclusive(async () => {
      this.verifyIdentity();
      return fn();
    });
  }

  /**
   * 校验 `.develop` 身份。
   * - 首次校验时若基线未知则采纳当前身份；
   * - 身份缺失 → PROJECT_STALE；
   * - 身份漂移 → 标记 stale 并 PROJECT_STALE（要求重载/重新发现，避免写错工程）。
   */
  verifyIdentity(): ProjectIdentity {
    this.assertUsable();
    const current = readProjectIdentity(this.root);
    if (!current) {
      this.markStale('.develop 缺失或无法解析');
      throw new ProjectResolutionError(
        `工程「${this.displayName}」的 .develop 缺失或无法解析，请重新检入或重载窗口`,
        'PROJECT_STALE',
      );
    }
    if (!this._identity) {
      this.adoptIdentity(current);
      return current;
    }
    if (!sameIdentity(this._identity, current)) {
      this.markStale('.develop 指向的云端工程已变更');
      throw new ProjectResolutionError(
        `工程「${this.displayName}」的 .develop 身份已变更（可能被其他工具重定向），请重载窗口后再操作`,
        'PROJECT_STALE',
      );
    }
    this._staleReason = undefined;
    return current;
  }

  /** 只读探测身份变化，不抛错（供刷新/诊断使用）。 */
  recheckIdentity(): IdentityCheck {
    const current = readProjectIdentity(this.root);
    if (!current) {
      this.markStale('.develop 缺失或无法解析');
      return 'missing';
    }
    if (!this._identity) {
      this.adoptIdentity(current);
      return 'adopted';
    }
    if (!sameIdentity(this._identity, current)) return 'changed';
    this._staleReason = undefined;
    return 'same';
  }

  /** 采纳新身份（重定向成功后由宿主调用）。 */
  adoptIdentity(identity: ProjectIdentity | undefined): void {
    this._identity = identity;
    this._staleReason = undefined;
    if (identity) {
      this.descriptor.projectUuid = identity.projectUuid;
      this.descriptor.serverUri = identity.serverUri;
      this.descriptor.fingerprint = identity.fingerprint;
    }
  }

  markStale(reason: string): void {
    const first = this._staleReason === undefined;
    this._staleReason = reason;
    if (first) this.options.onStale?.(this, reason);
    this.options.log?.error(`[${this.displayName}] 工程失效：${reason}`);
  }

  /** 同步释放（VS Code Disposable 语义）：关 SCM，通知 SDK 断开但不等 Java 桥退出。 */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    try {
      this._scm?.dispose();
    } catch {
      /* ignore */
    }
    this._scm = undefined;
    if (this._sdk) {
      void this._sdk.disconnect().catch(() => undefined);
    }
    if (this._closeSdk) {
      try {
        void Promise.resolve(this._closeSdk()).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }

  /** 优雅关闭：断开连接并等 Java 桥关闭。 */
  shutdown(): Promise<void> {
    if (this._shutdown) return this._shutdown;
    this._disposed = true;
    try {
      this._scm?.dispose();
    } catch {
      /* ignore */
    }
    this._scm = undefined;
    this._shutdown = (async () => {
      if (this._sdk) {
        try {
          await this._sdk.disconnect();
        } catch {
          /* 已断开 */
        }
      }
      if (this._closeSdk) {
        try {
          await this._closeSdk();
        } catch {
          /* 已退出 */
        }
      }
    })();
    return this._shutdown;
  }

  private assertUsable(): void {
    if (this._disposed) {
      throw new ProjectResolutionError(`工程「${this.displayName}」的上下文已释放`, 'DISPOSED');
    }
  }
}
