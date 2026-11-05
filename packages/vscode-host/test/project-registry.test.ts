import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BapSdk } from '@bap/sdk';
import { scanBackendProjectRoots, type BackendProjectRoot } from '../src/backend-projects';
import { buildProjectDescriptors, type BackendProjectDescriptor } from '../src/projects/discovery';
import { BackendProjectContext } from '../src/projects/project-context';
import { BackendProjectRegistry, type ProjectPicker } from '../src/projects/project-registry';
import { ProjectResolutionError } from '../src/projects/project-errors';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-reg-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 建工程目录（可选写入 .develop 身份）。 */
function mkProject(dir: string, projectUuid?: string, uri = 'ws://h:1'): string {
  fs.mkdirSync(dir, { recursive: true });
  const body = projectUuid
    ? `<Development Project="${projectUuid}" Uri="${uri}" User="root" Password="pwd"/>`
    : '<Development/>';
  fs.writeFileSync(path.join(dir, '.develop'), body, 'utf8');
  return dir;
}

function descriptorsFrom(roots: readonly BackendProjectRoot[]): BackendProjectDescriptor[] {
  return buildProjectDescriptors(roots);
}

function makeRegistry(
  descriptors: BackendProjectDescriptor[],
  overrides: {
    picker?: ProjectPicker;
    activePath?: string;
    log?: { debug(msg: string): void; error(msg: string): void };
  } = {},
): BackendProjectRegistry {
  return new BackendProjectRegistry(descriptors, {
    createContext: (d) =>
      new BackendProjectContext(d, {
        createSdk: () => ({}) as BapSdk,
      }),
    picker: overrides.picker,
    getActiveEditorPath: () => overrides.activePath,
    log: overrides.log ?? { debug: () => {}, error: () => {} },
  });
}

const fakePicker = (one: BackendProjectContext | undefined, many?: BackendProjectContext[]): ProjectPicker => ({
  async pickOne() {
    return one;
  },
  async pickMany() {
    return many;
  },
});

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

describe('BackendProjectRegistry 解析', () => {
  it('唯一工程 → only-project', async () => {
    const root = mkProject(path.join(tmp, 'p1'), 'uuid-1');
    const registry = makeRegistry(descriptorsFrom(scanBackendProjectRoots([root])));
    const res = await registry.resolve();
    expect(res.source).toBe('only-project');
    expect(res.context.root).toBe(root);
    expect(res.explicit).toBe(false);
  });

  it('多工程非交互 → AMBIGUOUS（带候选）', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    mkProject(path.join(tmp, 'p2'), 'uuid-2');
    const registry = makeRegistry(descriptorsFrom(scanBackendProjectRoots([tmp])));
    const p = registry.resolve({}, { interactive: false });
    await expectCode(p, 'AMBIGUOUS');
    await p.catch((e: ProjectResolutionError) => {
      expect(e.candidates.length).toBe(2);
    });
  });

  it('多工程交互 → QuickPick 选中（显式）', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    mkProject(path.join(tmp, 'p2'), 'uuid-2');
    const descriptors = descriptorsFrom(scanBackendProjectRoots([tmp]));
    const target = descriptors.find((d) => d.name === 'p2')!;
    const registry = makeRegistry(descriptors, {
      picker: fakePicker({
        projectId: target.projectId,
        displayName: target.displayName,
        root: target.root,
        isDisposed: false,
      } as unknown as BackendProjectContext),
    });
    const res = await registry.resolve({}, { interactive: true });
    expect(res.source).toBe('quick-pick');
    expect(res.context.root).toBe(path.join(tmp, 'p2'));
    expect(res.explicit).toBe(true);
  });

  it('显式 projectId 未知 → UNKNOWN_PROJECT', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    const registry = makeRegistry(descriptorsFrom(scanBackendProjectRoots([tmp])));
    await expectCode(registry.resolve({ projectId: 'nope' }), 'UNKNOWN_PROJECT');
  });

  it('显式路径不在任何工程内 → OUTSIDE_PROJECT（不回退）', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    const registry = makeRegistry(descriptorsFrom(scanBackendProjectRoots([tmp])), {
      activePath: path.join(tmp, 'p1', 'src', 'A.java'),
    });
    await expectCode(registry.resolve({ fsPath: path.join(tmp, 'elsewhere', 'A.java') }), 'OUTSIDE_PROJECT');
  });

  it('活动编辑器路径推断工程', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    mkProject(path.join(tmp, 'p2'), 'uuid-2');
    const registry = makeRegistry(descriptorsFrom(scanBackendProjectRoots([tmp])), {
      activePath: path.join(tmp, 'p2', 'src', 'core', 'A.java'),
    });
    const res = await registry.resolve();
    expect(res.source).toBe('active-editor');
    expect(res.context.root).toBe(path.join(tmp, 'p2'));
  });

  it('嵌套工程取最深根', () => {
    const outer = mkProject(path.join(tmp, 'outer'), 'uuid-1');
    const inner = mkProject(path.join(tmp, 'outer', 'inner'), 'uuid-2');
    const registry = makeRegistry(
      descriptorsFrom([...scanBackendProjectRoots([outer]), ...scanBackendProjectRoots([inner])]),
    );
    expect(registry.getByPath(path.join(inner, 'src', 'A.java'))?.root).toBe(inner);
    expect(registry.getByPath(path.join(outer, 'lib', 'A.jar'))?.root).toBe(outer);
  });

  it('虚拟 URI 通过 pid 定位工程', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    mkProject(path.join(tmp, 'p2'), 'uuid-2');
    const descriptors = descriptorsFrom(scanBackendProjectRoots([tmp]));
    const registry = makeRegistry(descriptors);
    const target = descriptors.find((d) => d.name === 'p1')!;
    const uri = {
      scheme: 'bap-original',
      query: `pid=${encodeURIComponent(target.projectId)}`,
      fsPath: '',
      toString: () => '',
    };
    const res = await registry.resolve({ resourceUri: uri as never });
    expect(res.source).toBe('virtual-uri');
    expect(res.context.projectId).toBe(target.projectId);
  });

  it('SCM 对象反查工程（显式）', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    const descriptors = descriptorsFrom(scanBackendProjectRoots([tmp]));
    const registry = makeRegistry(descriptors);
    const sc = { id: `bap:${descriptors[0].projectId}` };
    registry.registerScm(descriptors[0].projectId, sc as never, []);
    const res = await registry.resolve({ sourceControl: sc as never }, { forWrite: true });
    expect(res.source).toBe('source-control');
    expect(res.explicit).toBe(true);
  });
});

describe('BackendProjectRegistry 重复检出与批量', () => {
  it('隐式写操作拒绝重复检出；显式/SCM 允许', async () => {
    mkProject(path.join(tmp, 'a'), 'same-uuid', 'ws://h:1');
    mkProject(path.join(tmp, 'b'), 'same-uuid', 'ws://h:1');
    const descriptors = descriptorsFrom(scanBackendProjectRoots([tmp]));
    expect(descriptors.every((d) => d.peerProjectIds.length === 1)).toBe(true);
    const a = descriptors.find((d) => d.name === 'a')!;
    const b = descriptors.find((d) => d.name === 'b')!;
    const registry = makeRegistry(descriptors);

    registry.markUsed(a.projectId);
    await expectCode(registry.resolve({}, { forWrite: true }), 'DUPLICATE_CHECKOUT');

    // 只读允许
    const read = await registry.resolve({}, { forWrite: false });
    expect(read.context.projectId).toBe(a.projectId);

    // 显式选择允许写
    const explicit = await registry.resolve({ projectId: b.projectId }, { forWrite: true });
    expect(explicit.explicit).toBe(true);
  });

  it('resolveMany 批量：勾选多个工程并按勾选顺序返回', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    mkProject(path.join(tmp, 'p2'), 'uuid-2');
    const descriptors = descriptorsFrom(scanBackendProjectRoots([tmp]));
    const byName = (n: string) => descriptors.find((d) => d.name === n)!;
    const pickedIds = [byName('p2').projectId, byName('p1').projectId];
    const picker: ProjectPicker = {
      async pickOne() {
        return undefined;
      },
      async pickMany(candidates) {
        return pickedIds.map(
          (id) => candidates.find((c) => c.projectId === id)!,
        );
      },
    };
    const registry = makeRegistry(descriptors, { picker });
    const res = await registry.resolveMany({}, { interactive: true, batch: true, forWrite: true });
    expect(res.map((r) => r.context.root)).toEqual([path.join(tmp, 'p2'), path.join(tmp, 'p1')]);
    expect(res.every((r) => r.source === 'batch' && r.explicit)).toBe(true);
  });

  it('resolveMany 取消选择 → CANCELLED', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    mkProject(path.join(tmp, 'p2'), 'uuid-2');
    const registry = makeRegistry(descriptorsFrom(scanBackendProjectRoots([tmp])), {
      picker: fakePicker(undefined, []),
    });
    await expectCode(registry.resolveMany({}, { interactive: true, batch: true }), 'CANCELLED');
  });

  it('resolveMany 显式定位只返回该工程', async () => {
    mkProject(path.join(tmp, 'p1'), 'uuid-1');
    mkProject(path.join(tmp, 'p2'), 'uuid-2');
    const descriptors = descriptorsFrom(scanBackendProjectRoots([tmp]));
    const registry = makeRegistry(descriptors);
    const res = await registry.resolveMany({ projectId: descriptors[0].projectId }, { batch: true });
    expect(res).toHaveLength(1);
    expect(res[0].source).toBe('explicit-id');
  });
});
