// Skill 安装器：多 skill 枚举、VF 根校验、覆盖/跳过、符号链接与路径安全（P1-11）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isSafeSkillName,
  listBundledSkills,
  resolveBundledSkillsRoot,
  planSkillInstall,
  installSkillPlan,
} from '../src/skill/skill-installer';

let tmp: string;
let skillsRoot: string;
let vfRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-skill-'));
  skillsRoot = path.join(tmp, 'bundled');
  vfRoot = path.join(tmp, 'vf');
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.mkdirSync(vfRoot, { recursive: true });
  fs.mkdirSync(path.join(vfRoot, '.votaforge'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkSkill(name: string, files: Record<string, string> = { 'SKILL.md': `# ${name}` }): string {
  const dir = path.join(skillsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return dir;
}

describe('isSafeSkillName', () => {
  it('只接受单层安全名称', () => {
    expect(isSafeSkillName('bap-vscode-mcp')).toBe(true);
    expect(isSafeSkillName('a.b_c-1')).toBe(true);
    expect(isSafeSkillName('../evil')).toBe(false);
    expect(isSafeSkillName('a/b')).toBe(false);
    expect(isSafeSkillName('.hidden')).toBe(false);
    expect(isSafeSkillName('')).toBe(false);
    expect(isSafeSkillName('-x')).toBe(false);
  });
});

describe('listBundledSkills', () => {
  it('枚举全部含 SKILL.md 的直接子目录并按名称排序', () => {
    mkSkill('zeta');
    mkSkill('alpha');
    fs.mkdirSync(path.join(skillsRoot, 'not-a-skill'));
    fs.writeFileSync(path.join(skillsRoot, 'SKILL.md'), '# root');
    const skills = listBundledSkills(skillsRoot);
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });

  it('跳过非法名称目录与缺失目录', () => {
    mkSkill('ok');
    fs.mkdirSync(path.join(skillsRoot, 'bad name'));
    fs.writeFileSync(path.join(skillsRoot, 'bad name', 'SKILL.md'), '# x');
    expect(listBundledSkills(skillsRoot).map((s) => s.name)).toEqual(['ok']);
    expect(listBundledSkills(path.join(tmp, 'nope'))).toEqual([]);
  });
});

describe('resolveBundledSkillsRoot', () => {
  it('优先 extensionPath/assets/skill', () => {
    const ext = path.join(tmp, 'ext');
    fs.mkdirSync(path.join(ext, 'assets', 'skill', 'a'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'assets', 'skill', 'a', 'SKILL.md'), '# a');
    expect(resolveBundledSkillsRoot(ext)).toBe(path.join(ext, 'assets', 'skill'));
  });

  it('F5 回退到 <extensionPath>/../../skill', () => {
    const ext = path.join(tmp, 'repo', 'apps', 'vscode');
    fs.mkdirSync(ext, { recursive: true });
    const repoSkill = path.join(tmp, 'repo', 'skill', 'a');
    fs.mkdirSync(repoSkill, { recursive: true });
    fs.writeFileSync(path.join(repoSkill, 'SKILL.md'), '# a');
    expect(resolveBundledSkillsRoot(ext)).toBe(path.join(tmp, 'repo', 'skill'));
  });

  it('都没有 → undefined', () => {
    expect(resolveBundledSkillsRoot(path.join(tmp, 'empty'))).toBeUndefined();
  });
});

describe('planSkillInstall', () => {
  it('非 VotaForge 根 → 报错且不创建 .votaforge', () => {
    mkSkill('a');
    const nonVf = path.join(tmp, 'plain');
    fs.mkdirSync(nonVf);
    expect(() => planSkillInstall(skillsRoot, nonVf)).toThrow(/VotaForge/);
    expect(fs.existsSync(path.join(nonVf, '.votaforge'))).toBe(false);
  });

  it('没有任何 skill → 报错', () => {
    expect(() => planSkillInstall(skillsRoot, vfRoot)).toThrow(/SKILL\.md/);
  });

  it('生成全部 skill 的目标路径与已存在标记', () => {
    mkSkill('a');
    mkSkill('b');
    fs.mkdirSync(path.join(vfRoot, '.votaforge', 'skill', 'b'), { recursive: true });
    const plan = planSkillInstall(skillsRoot, vfRoot);
    expect(plan.targetRoot).toBe(path.join(vfRoot, '.votaforge', 'skill'));
    expect(plan.skills.map((s) => s.name)).toEqual(['a', 'b']);
    expect(plan.skills.find((s) => s.name === 'a')!.exists).toBe(false);
    expect(plan.skills.find((s) => s.name === 'b')!.exists).toBe(true);
  });

  it('skill 父目录是符号链接 → 拒绝安装，不写到 VF 根之外', () => {
    mkSkill('a');
    const outside = path.join(tmp, 'outside-skill');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(vfRoot, '.votaforge', 'skill'), 'dir');
    expect(() => planSkillInstall(skillsRoot, vfRoot)).toThrow(/符号链接/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('.votaforge 是符号链接 → 拒绝安装', () => {
    mkSkill('a');
    const outside = path.join(tmp, 'outside-vf');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(vfRoot, '.votaforge'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(vfRoot, '.votaforge'), 'dir');
    expect(() => planSkillInstall(skillsRoot, vfRoot)).toThrow(/符号链接/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('installSkillPlan', () => {
  it('复制全部 skill（含子目录），跳过 .DS_Store', () => {
    mkSkill('a', {
      'SKILL.md': '# a',
      'references/x.md': 'x',
      '.DS_Store': 'junk',
    });
    mkSkill('b', { 'SKILL.md': '# b' });
    const plan = planSkillInstall(skillsRoot, vfRoot);
    const result = installSkillPlan(plan, { overwrite: false });
    expect(result.installed).toEqual(['a', 'b']);
    expect(result.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(vfRoot, '.votaforge', 'skill', 'a', 'SKILL.md'), 'utf8')).toBe('# a');
    expect(fs.readFileSync(path.join(vfRoot, '.votaforge', 'skill', 'a', 'references', 'x.md'), 'utf8')).toBe('x');
    expect(fs.existsSync(path.join(vfRoot, '.votaforge', 'skill', 'a', '.DS_Store'))).toBe(false);
  });

  it('目标已存在且未确认覆盖 → 跳过并保留原内容', () => {
    mkSkill('a', { 'SKILL.md': '# NEW' });
    const target = path.join(vfRoot, '.votaforge', 'skill', 'a');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), '# OLD');
    const plan = planSkillInstall(skillsRoot, vfRoot);
    const result = installSkillPlan(plan, { overwrite: false });
    expect(result.installed).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ name: 'a' });
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('# OLD');
  });

  it('确认覆盖 → 原子替换，旧文件不残留', () => {
    mkSkill('a', { 'SKILL.md': '# NEW' });
    const target = path.join(vfRoot, '.votaforge', 'skill', 'a');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'old.txt'), 'old');
    const plan = planSkillInstall(skillsRoot, vfRoot);
    const result = installSkillPlan(plan, { overwrite: true });
    expect(result.installed).toEqual(['a']);
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('# NEW');
    expect(fs.existsSync(path.join(target, 'old.txt'))).toBe(false);
    // 临时/备份目录不残留
    const leftovers = fs
      .readdirSync(path.join(vfRoot, '.votaforge', 'skill'))
      .filter((n) => n.startsWith('.'));
    expect(leftovers).toEqual([]);
  });

  it('目标是符号链接 → 跳过，不跟随写入', () => {
    mkSkill('a');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const target = path.join(vfRoot, '.votaforge', 'skill', 'a');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target, 'dir');
    const plan = planSkillInstall(skillsRoot, vfRoot);
    const result = installSkillPlan(plan, { overwrite: true });
    expect(result.installed).toEqual([]);
    expect(result.skipped[0].reason).toContain('符号链接');
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(false);
  });
});
