// 领域 skill 安装器（纯 Node，不依赖 vscode）：枚举随扩展分发的 skill 目录，
// 整体复制到 <vf根>/.votaforge/skill/<name>。支持未来任意多个 skill，不写死名称。
// 只在用户显式触发时写入；覆盖同名目录必须先经调用方确认。
import * as fs from 'fs';
import * as path from 'path';
import { VF_DIR, isVfWorkspaceRoot } from '../backend-projects';

/** 复制时跳过的条目（不进入子目录。.git/node_modules 目录整体跳过）。 */
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules']);

export interface BundledSkill {
  name: string;
  sourceDir: string;
}

export interface SkillInstallEntry {
  name: string;
  sourceDir: string;
  targetDir: string;
  /** 目标已存在（文件/目录）。 */
  exists: boolean;
  /** 目标是符号链接：不覆盖、不跟随。 */
  isSymlink: boolean;
}

export interface SkillInstallPlan {
  skillsRoot: string;
  vfRoot: string;
  targetRoot: string;
  skills: SkillInstallEntry[];
}

export interface SkillInstallResult {
  installed: string[];
  skipped: { name: string; reason: string }[];
  warnings: string[];
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * 目标路径的已存在祖先不得是符号链接：否则 `.votaforge` / `.votaforge/skill`
 * 被链接到工作区外时，mkdir/rename 会穿透链接，把 skill 写到 VF 根之外。
 * 不存在的后续目录由安装器创建，不存在逃逸。
 */
function assertNoSymlinkAncestor(vfRoot: string, targetRoot: string): void {
  const rel = path.relative(vfRoot, targetRoot);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`skill 安装目录不在 VotaForge 根内：${targetRoot}`);
  }
  let cur = vfRoot;
  for (const part of rel.split(path.sep)) {
    if (!part) continue;
    cur = path.join(cur, part);
    const st = lstatOr(cur);
    if (!st) return;
    if (st.isSymbolicLink()) {
      throw new Error(`skill 安装目录的父级是符号链接，已拒绝：${cur}`);
    }
  }
}

function lstatOr(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** skill 目录名必须是单层安全名称（防路径穿越）。 */
export function isSafeSkillName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  );
}

/** 枚举 `<skillsRoot>` 下含 SKILL.md 的直接子目录（排序、跳过符号链接）。 */
export function listBundledSkills(skillsRoot: string): BundledSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: BundledSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!isSafeSkillName(entry.name)) continue;
    const sourceDir = path.join(skillsRoot, entry.name);
    if (!isFile(path.join(sourceDir, 'SKILL.md'))) continue;
    out.push({ name: entry.name, sourceDir });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * 解析随扩展分发的 skill 根：
 * - 打包后：<extensionPath>/assets/skill（stage-skills.js 复制）
 * - F5 开发：<extensionPath>/../../skill（仓库根 skill/）
 */
export function resolveBundledSkillsRoot(extensionPath: string): string | undefined {
  const candidates = [
    path.join(extensionPath, 'assets', 'skill'),
    path.resolve(extensionPath, '..', '..', 'skill'),
  ];
  for (const candidate of candidates) {
    if (listBundledSkills(candidate).length > 0) return candidate;
  }
  return undefined;
}

/**
 * 生成安装计划：目标是已存在的 VotaForge 根，安装到 `<vf>/.votaforge/skill/`。
 * 只做只读检查，不创建任何目录。
 */
export function planSkillInstall(skillsRoot: string, vfRootInput: string): SkillInstallPlan {
  const vfRoot = path.resolve(vfRootInput);
  if (!isVfWorkspaceRoot(vfRoot)) {
    throw new Error(`不是 VotaForge 工作区根（缺少 votaforge.workspace.json 或 .votaforge/）：${vfRoot}`);
  }
  const skills = listBundledSkills(skillsRoot);
  if (skills.length === 0) {
    throw new Error(`未在 ${skillsRoot} 找到任何含 SKILL.md 的 skill 目录`);
  }
  const targetRoot = path.join(vfRoot, VF_DIR, 'skill');
  if (!isInsidePath(vfRoot, targetRoot) || path.dirname(targetRoot) !== path.join(vfRoot, VF_DIR)) {
    throw new Error(`非法的 skill 安装目录：${targetRoot}`);
  }
  assertNoSymlinkAncestor(vfRoot, targetRoot);

  const entries: SkillInstallEntry[] = skills.map((s) => {
    const targetDir = path.join(targetRoot, s.name);
    if (path.dirname(targetDir) !== targetRoot || !isInsidePath(targetRoot, targetDir)) {
      throw new Error(`非法的 skill 名称：${s.name}`);
    }
    const st = lstatOr(targetDir);
    return {
      name: s.name,
      sourceDir: s.sourceDir,
      targetDir,
      exists: !!st,
      isSymlink: !!st?.isSymbolicLink(),
    };
  });

  return { skillsRoot, vfRoot, targetRoot, skills: entries };
}

function copyDirectory(src: string, dst: string, warnings: string[]): void {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      warnings.push(`跳过符号链接：${from}`);
      continue;
    }
    if (entry.isDirectory()) {
      copyDirectory(from, to, warnings);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * 执行安装计划。overwrite=false 时跳过已存在目录；true 时先复制到临时目录，
 * 再用 rename 原子替换（失败恢复备份）。符号链接目标永远跳过。
 */
export function installSkillPlan(
  plan: SkillInstallPlan,
  opts: { overwrite: boolean },
): SkillInstallResult {
  const result: SkillInstallResult = { installed: [], skipped: [], warnings: [] };
  if (!isInsidePath(plan.vfRoot, plan.targetRoot)) {
    throw new Error(`skill 安装目录不在 VotaForge 根内：${plan.targetRoot}`);
  }
  // plan 与 install 之间父级可能被替换成符号链接，写入前再校验一次。
  assertNoSymlinkAncestor(plan.vfRoot, plan.targetRoot);
  fs.mkdirSync(plan.targetRoot, { recursive: true });

  let seq = 0;
  for (const skill of plan.skills) {
    const st = lstatOr(skill.targetDir);
    if (st?.isSymbolicLink()) {
      result.skipped.push({ name: skill.name, reason: '目标是符号链接，已跳过' });
      continue;
    }
    if (st && !st.isDirectory()) {
      result.skipped.push({ name: skill.name, reason: '目标是普通文件，已跳过' });
      continue;
    }
    if (st && !opts.overwrite) {
      result.skipped.push({ name: skill.name, reason: '目标已存在（未确认覆盖）' });
      continue;
    }

    const suffix = `${process.pid}-${seq++}`;
    const tempDir = path.join(plan.targetRoot, `.${skill.name}.tmp-${suffix}`);
    const backupDir = path.join(plan.targetRoot, `.${skill.name}.bak-${suffix}`);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      copyDirectory(skill.sourceDir, tempDir, result.warnings);
      const hadTarget = !!st;
      if (hadTarget) fs.renameSync(skill.targetDir, backupDir);
      try {
        fs.renameSync(tempDir, skill.targetDir);
      } catch (e) {
        // 替换失败：恢复原目录，避免用户丢失旧版本。
        if (hadTarget && !lstatOr(skill.targetDir) && lstatOr(backupDir)) {
          fs.renameSync(backupDir, skill.targetDir);
        }
        throw e;
      }
      fs.rmSync(backupDir, { recursive: true, force: true });
      result.installed.push(skill.name);
    } catch (e) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (!lstatOr(skill.targetDir) && lstatOr(backupDir)) {
        try {
          fs.renameSync(backupDir, skill.targetDir);
        } catch {
          /* 恢复失败：保留备份目录，交由用户处理 */
          result.warnings.push(`恢复备份失败：${backupDir}`);
        }
      }
      result.skipped.push({ name: skill.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
