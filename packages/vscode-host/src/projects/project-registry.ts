// 多后端工程注册表：工程解析（显式定位 → 活动编辑器 → 上次使用 → 唯一 → QuickPick）、
// SCM 对象反查、重复检出标记、身份刷新。不依赖 vscode 运行时（仅类型引用），便于单测。
import type * as vscode from 'vscode';
import type { BackendProjectContext } from './project-context';
import type { BackendProjectDescriptor } from './discovery';
import { ProjectResolutionError, type ProjectCandidate } from './project-errors';
import { isPathInside, pathKey } from './project-paths';
import { readProjectIdentity } from './project-identity';
import { parseQueryString, projectIdFromUriString } from '../history/history-uri';

export interface ProjectRequest {
  projectId?: string;
  sourceControl?: vscode.SourceControl;
  resourceGroup?: vscode.SourceControlResourceGroup;
  resourceUri?: vscode.Uri;
  fsPath?: string;
  virtualUri?: vscode.Uri;
}

export type ResolutionSource =
  | 'explicit-id'
  | 'source-control'
  | 'resource-group'
  | 'path'
  | 'virtual-uri'
  | 'active-editor'
  | 'last-used'
  | 'only-project'
  | 'quick-pick'
  | 'batch';

export interface ProjectResolution {
  context: BackendProjectContext;
  source: ResolutionSource;
  /** 显式定位（参数/SCM/路径/虚拟 URI/QuickPick/批量勾选）——重复检出允许写。 */
  explicit: boolean;
}

export interface ResolveOptions {
  /** 是否允许弹 QuickPick（MCP/工具调用必须传 false）。 */
  interactive?: boolean;
  /** 写操作：隐式解析到重复检出时拒绝。 */
  forWrite?: boolean;
  /** 是否允许用活动编辑器推断工程。默认 true。 */
  allowActiveEditor?: boolean;
  /** 是否允许回退到「上次使用的工程」。默认 true。 */
  allowLastUsed?: boolean;
  /** QuickPick 提示语中的动作名。 */
  purpose?: string;
}

export interface ResolveManyOptions extends ResolveOptions {
  /** 无资源命令：多工程时列出目标并多选。 */
  batch?: boolean;
}

export interface ProjectPicker {
  pickOne(candidates: readonly BackendProjectContext[], purpose: string): Promise<BackendProjectContext | undefined>;
  pickMany(
    candidates: readonly BackendProjectContext[],
    purpose: string,
    defaults: readonly BackendProjectContext[],
  ): Promise<BackendProjectContext[] | undefined>;
}

export interface BackendProjectRegistryOptions {
  createContext: (descriptor: BackendProjectDescriptor) => BackendProjectContext;
  picker?: ProjectPicker;
  getActiveEditorPath?: () => string | undefined;
  log?: { debug(msg: string): void; error(msg: string): void };
}

/**
 * 工程注册表。解析优先级（P1-6）：
 * 显式 projectId → sourceControl → resourceGroup → 显式路径 → 虚拟 URI → 活动编辑器
 * → 上次使用 → 唯一工程 → QuickPick（仅 UI）→ 报错。
 * 显式路径不在任何工程内时**不回退**（OUTSIDE_PROJECT），避免命令作用于错误工程。
 */
export class BackendProjectRegistry {
  private readonly contexts: BackendProjectContext[];
  private readonly byId = new Map<string, BackendProjectContext>();
  private readonly scmOwners = new Map<vscode.SourceControl, string>();
  private readonly groupOwners = new Map<vscode.SourceControlResourceGroup, string>();
  private readonly providerOwners = new Map<string, string>();
  private readonly options: BackendProjectRegistryOptions;
  private lastUsedId: string | undefined;
  private disposed = false;

  constructor(descriptors: readonly BackendProjectDescriptor[], options: BackendProjectRegistryOptions) {
    this.options = options;
    this.contexts = descriptors.map((d) => options.createContext(d));
    for (const ctx of this.contexts) this.byId.set(ctx.projectId, ctx);
    this.recomputeDuplicates();
  }

  getAll(): readonly BackendProjectContext[] {
    return this.contexts;
  }

  getById(projectId: string): BackendProjectContext | undefined {
    return this.byId.get(projectId);
  }

  getByRoot(root: string): BackendProjectContext | undefined {
    const key = pathKey(root);
    return this.contexts.find((c) => pathKey(c.root) === key);
  }

  /** 包含该路径的最深工程（嵌套工程时取更具体者）。 */
  getByPath(fsPath: string): BackendProjectContext | undefined {
    let best: BackendProjectContext | undefined;
    let bestLen = -1;
    for (const ctx of this.contexts) {
      if (!isPathInside(ctx.root, fsPath)) continue;
      const len = pathKey(ctx.root).length;
      if (len > bestLen) {
        best = ctx;
        bestLen = len;
      }
    }
    return best;
  }

  /** 该路径是否由指定工程拥有（防止 watcher 跨工程刷新）。 */
  ownsPath(projectId: string, fsPath: string): boolean {
    return this.getByPath(fsPath)?.projectId === projectId;
  }

  registerScm(
    projectId: string,
    sourceControl: vscode.SourceControl,
    groups: readonly vscode.SourceControlResourceGroup[] = [],
  ): void {
    this.scmOwners.set(sourceControl, projectId);
    this.providerOwners.set(sourceControl.id, projectId);
    for (const g of groups) this.groupOwners.set(g, projectId);
  }

  getBySourceControl(sourceControl: vscode.SourceControl | undefined): BackendProjectContext | undefined {
    if (!sourceControl || typeof sourceControl !== 'object') return undefined;
    const id = this.scmOwners.get(sourceControl) ?? this.providerOwners.get(sourceControl.id);
    return id ? this.byId.get(id) : undefined;
  }

  getByGroup(group: vscode.SourceControlResourceGroup | undefined): BackendProjectContext | undefined {
    if (!group || typeof group !== 'object') return undefined;
    const id = this.groupOwners.get(group);
    return id ? this.byId.get(id) : undefined;
  }

  getByProviderId(providerId: string): BackendProjectContext | undefined {
    const id = this.providerOwners.get(providerId);
    return id ? this.byId.get(id) : undefined;
  }

  markUsed(projectId: string): void {
    if (this.byId.has(projectId)) this.lastUsedId = projectId;
  }

  getLastUsed(): BackendProjectContext | undefined {
    return this.lastUsedId ? this.byId.get(this.lastUsedId) : undefined;
  }

  /** 解析到单个工程。 */
  async resolve(req: ProjectRequest = {}, opts: ResolveOptions = {}): Promise<ProjectResolution> {
    this.assertUsable();
    const explicit = this.resolveExplicit(req);
    if (explicit) {
      if (explicit.source !== 'virtual-uri' || explicit.explicit) this.markUsed(explicit.context.projectId);
      this.assertWriteAllowed(explicit.context, explicit.explicit, opts);
      return explicit;
    }

    if (opts.allowActiveEditor !== false) {
      const activePath = this.activeEditorPath();
      if (activePath) {
        const ctx = this.getByPath(activePath);
        if (ctx) {
          const res: ProjectResolution = { context: ctx, source: 'active-editor', explicit: false };
          this.assertWriteAllowed(ctx, false, opts);
          return res;
        }
      }
    }

    if (opts.allowLastUsed !== false) {
      const last = this.getLastUsed();
      if (last && !last.isDisposed) {
        const res: ProjectResolution = { context: last, source: 'last-used', explicit: false };
        this.assertWriteAllowed(last, false, opts);
        return res;
      }
    }

    if (this.contexts.length === 0) {
      throw new ProjectResolutionError(
        '当前窗口没有发现后端工程（未找到 .develop），请打开或下载 BAP 工程',
        'NO_PROJECTS',
      );
    }
    if (this.contexts.length === 1) {
      const only = this.contexts[0];
      const res: ProjectResolution = { context: only, source: 'only-project', explicit: false };
      this.assertWriteAllowed(only, false, opts);
      return res;
    }

    if (opts.interactive && this.options.picker) {
      const picked = await this.options.picker.pickOne(this.contexts, opts.purpose ?? '选择后端工程');
      if (!picked) throw new ProjectResolutionError('已取消选择工程', 'CANCELLED');
      this.markUsed(picked.projectId);
      const res: ProjectResolution = { context: picked, source: 'quick-pick', explicit: true };
      this.assertWriteAllowed(picked, true, opts);
      return res;
    }

    throw new ProjectResolutionError(
      `窗口内有 ${this.contexts.length} 个后端工程，无法确定目标工程；请从 SCM 资源或文件上操作`,
      'AMBIGUOUS',
      this.candidates(),
    );
  }

  /**
   * 无资源命令的目标解析：显式定位只作用于该工程；否则多工程列出并多选。
   * 批量结果按用户勾选顺序返回。
   */
  async resolveMany(req: ProjectRequest = {}, opts: ResolveManyOptions = {}): Promise<ProjectResolution[]> {
    this.assertUsable();
    const explicit = this.resolveExplicit(req);
    if (explicit) {
      this.markUsed(explicit.context.projectId);
      this.assertWriteAllowed(explicit.context, explicit.explicit, opts);
      return [explicit];
    }

    if (this.contexts.length === 0) {
      throw new ProjectResolutionError(
        '当前窗口没有发现后端工程（未找到 .develop），请打开或下载 BAP 工程',
        'NO_PROJECTS',
      );
    }
    if (!opts.batch) {
      return [await this.resolve(req, opts)];
    }
    if (this.contexts.length === 1) {
      const only = this.contexts[0];
      this.assertWriteAllowed(only, false, opts);
      return [{ context: only, source: 'only-project', explicit: false }];
    }
    if (!opts.interactive || !this.options.picker) {
      return [await this.resolve(req, opts)];
    }

    const defaults = opts.forWrite ? this.likelyDefaults() : [...this.contexts];
    const picked = await this.options.picker.pickMany(
      this.contexts,
      opts.purpose ?? '选择要执行的后端工程',
      defaults,
    );
    if (!picked || picked.length === 0) {
      throw new ProjectResolutionError('已取消选择工程', 'CANCELLED');
    }
    const unique = [...new Map(picked.map((c) => [c.projectId, c])).values()];
    for (const ctx of unique) this.assertWriteAllowed(ctx, true, opts);
    this.markUsed(unique[0].projectId);
    return unique.map((context) => ({ context, source: 'batch', explicit: true }));
  }

  /**
   * 重新读取 `.develop` 身份；漂移时断开旧连接、采纳新身份并重算重复检出。
   * 返回最新上下文（工程不存在时返回 undefined）。
   */
  async refreshIdentity(projectId: string): Promise<BackendProjectContext | undefined> {
    const ctx = this.getById(projectId);
    if (!ctx) return undefined;
    const current = readProjectIdentity(ctx.root);
    if (!current) {
      ctx.markStale('.develop 缺失或无法解析');
      return ctx;
    }
    if (!ctx.identity) {
      ctx.adoptIdentity(current);
      this.recomputeDuplicates();
      return ctx;
    }
    if (ctx.identity.fingerprint !== current.fingerprint) {
      this.options.log?.debug(
        `[${ctx.displayName}] .develop 身份变更：${ctx.identity.fingerprint} → ${current.fingerprint}`,
      );
      if (ctx.sdk) {
        try {
          await ctx.sdk.disconnect();
        } catch {
          /* 旧连接可能已断开 */
        }
      }
      ctx.adoptIdentity(current);
      this.recomputeDuplicates();
    }
    return ctx;
  }

  /** 重算「同一云端工程多份检出」。 */
  recomputeDuplicates(): void {
    for (const ctx of this.contexts) {
      ctx.descriptor.duplicateProjectUuid = undefined;
      ctx.descriptor.peerProjectIds = [];
    }
    const groups = new Map<string, BackendProjectContext[]>();
    for (const ctx of this.contexts) {
      ctx.descriptor.fingerprint = ctx.identity?.fingerprint;
      const fp = ctx.identity?.fingerprint;
      if (!fp) continue;
      const list = groups.get(fp);
      if (list) list.push(ctx);
      else groups.set(fp, [ctx]);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      for (const ctx of list) {
        ctx.descriptor.duplicateProjectUuid = ctx.identity?.projectUuid;
        ctx.descriptor.peerProjectIds = list
          .filter((o) => o.projectId !== ctx.projectId)
          .map((o) => o.projectId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ctx of this.contexts) ctx.dispose();
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    await Promise.all(this.contexts.map((c) => c.shutdown()));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ---- 内部 ----

  private candidates(): ProjectCandidate[] {
    return this.contexts.map((c) => ({ projectId: c.projectId, displayName: c.displayName, root: c.root }));
  }

  private assertUsable(): void {
    if (this.disposed) throw new ProjectResolutionError('BAP 工程注册表已释放', 'DISPOSED');
  }

  private assertWriteAllowed(ctx: BackendProjectContext, explicit: boolean, opts: ResolveOptions): void {
    if (!opts.forWrite || explicit) return;
    if (!ctx.isDuplicateCheckout) return;
    const peers = ctx.descriptor.peerProjectIds
      .map((id) => this.byId.get(id)?.displayName ?? id)
      .join('、');
    throw new ProjectResolutionError(
      `工程「${ctx.displayName}」与 ${peers} 是同一云端工程的多份检出；写操作请从具体 SCM 资源/文件触发，或显式选择工程`,
      'DUPLICATE_CHECKOUT',
    );
  }

  private activeEditorPath(): string | undefined {
    try {
      return this.options.getActiveEditorPath?.();
    } catch {
      return undefined;
    }
  }

  private likelyDefaults(): BackendProjectContext[] {
    const last = this.getLastUsed();
    if (last && !last.isDisposed && !last.isDuplicateCheckout) return [last];
    const activePath = this.activeEditorPath();
    if (activePath) {
      const ctx = this.getByPath(activePath);
      if (ctx && !ctx.isDuplicateCheckout) return [ctx];
    }
    return [];
  }

  /** 仅解析显式定位；没有显式定位返回 undefined。 */
  private resolveExplicit(req: ProjectRequest): ProjectResolution | undefined {
    if (req.projectId) {
      const ctx = this.getById(req.projectId);
      if (!ctx) {
        throw new ProjectResolutionError(
          `未知工程：${req.projectId}`,
          'UNKNOWN_PROJECT',
          this.candidates(),
        );
      }
      return { context: ctx, source: 'explicit-id', explicit: true };
    }
    if (req.sourceControl) {
      const ctx = this.getBySourceControl(req.sourceControl);
      if (!ctx) {
        throw new ProjectResolutionError('该源代码管理视图未注册到 BAP 工程', 'UNKNOWN_PROJECT', this.candidates());
      }
      return { context: ctx, source: 'source-control', explicit: true };
    }
    if (req.resourceGroup) {
      const ctx = this.getByGroup(req.resourceGroup);
      if (!ctx) {
        throw new ProjectResolutionError('该资源组未注册到 BAP 工程', 'UNKNOWN_PROJECT', this.candidates());
      }
      return { context: ctx, source: 'resource-group', explicit: true };
    }

    const uri = req.resourceUri;
    if (uri && uri.scheme && uri.scheme !== 'file') {
      const res = this.resolveVirtual(uri);
      if (res) return res;
    }
    if (uri?.fsPath) return this.resolvePath(uri.fsPath);
    if (req.fsPath) return this.resolvePath(req.fsPath);
    if (req.virtualUri) return this.resolveVirtual(req.virtualUri);
    return undefined;
  }

  private resolvePath(fsPath: string): ProjectResolution {
    const ctx = this.getByPath(fsPath);
    if (!ctx) {
      throw new ProjectResolutionError(
        `路径不在任何已发现的后端工程内：${fsPath}`,
        'OUTSIDE_PROJECT',
      );
    }
    return { context: ctx, source: 'path', explicit: true };
  }

  private resolveVirtual(uri: vscode.Uri): ProjectResolution | undefined {
    let pid: string | undefined;
    try {
      pid = uri.query ? parseQueryString(uri.query).pid : undefined;
    } catch {
      pid = undefined;
    }
    if (!pid) pid = projectIdFromUriString(uri.toString());
    if (pid) {
      const ctx = this.getById(pid);
      if (!ctx) {
        throw new ProjectResolutionError(`虚拟 URI 指向未知工程：${pid}`, 'UNKNOWN_PROJECT', this.candidates());
      }
      return { context: ctx, source: 'virtual-uri', explicit: true };
    }
    if (this.contexts.length === 1) {
      return { context: this.contexts[0], source: 'virtual-uri', explicit: true };
    }
    if (this.contexts.length === 0) {
      throw new ProjectResolutionError('当前窗口没有发现后端工程', 'NO_PROJECTS');
    }
    throw new ProjectResolutionError(
      '虚拟 URI 缺少工程标识（pid），无法确定属于哪个工程',
      'AMBIGUOUS',
      this.candidates(),
    );
  }
}
