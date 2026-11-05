// 把仓库根 skill/ 下的所有 skill 目录（含 SKILL.md）复制到 assets/skill/，随 VSIX 分发。
// 调用链：... && node scripts/stage-skills.js && node esbuild.js --production
// 不写死 skill 名称：枚举全部含 SKILL.md 的直接子目录（支持后续新增 skill）。
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const srcRoot = path.join(repoRoot, 'skill');
const destRoot = path.join(appRoot, 'assets', 'skill');

const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules']);

function isSkillDir(dir) {
  return fs.existsSync(path.join(dir, 'SKILL.md'));
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

if (!fs.existsSync(srcRoot)) {
  console.error(`[stage-skills] 未找到 skill 源目录 ${srcRoot}`);
  process.exit(1);
}

const skills = fs
  .readdirSync(srcRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .filter((name) => isSkillDir(path.join(srcRoot, name)))
  .sort();

if (skills.length === 0) {
  console.error(`[stage-skills] ${srcRoot} 下没有任何含 SKILL.md 的 skill 目录`);
  process.exit(1);
}

fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });
for (const name of skills) {
  copyDir(path.join(srcRoot, name), path.join(destRoot, name));
}
console.log(`[stage-skills] staged ${skills.length} skills (${skills.join(', ')}) -> ${destRoot}`);
