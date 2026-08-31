#!/usr/bin/env node
// 打包 .vsix 到仓库根 dist/。
// 背景：npm workspace 跑 `npm run package -w` 会让 vsce 的 cwd 落到仓库根，导致越界报错
//（把 ../packages、根 node_modules 等都纳入并报 invalid relative path）。
// 这里：先在根构建（bridge + stage + esbuild production），再在 apps/vscode 内打包 -> 根 dist/。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..'); // apps/vscode/scripts -> 仓库根
const appDir = path.resolve(root, 'apps', 'vscode');
const distDir = path.resolve(root, 'dist');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

console.log(`[package-dist] 根 = ${root}`);
fs.mkdirSync(distDir, { recursive: true });

// 1) 根构建（编译 Java 桥 + stage 到 assets + esbuild --production）
run('npm run build', { cwd: root });

// 2) 打包到根 dist/（临时跳过 vscode:prepublish 重复构建，直接复用已产出的 dist/）
const pkgPath = path.join(appDir, 'package.json');
const origText = fs.readFileSync(pkgPath, 'utf8');
const origJson = JSON.parse(origText);
const savedPrepublish = origJson.scripts && origJson.scripts['vscode:prepublish'];
try {
  const j = JSON.parse(origText);
  j.scripts['vscode:prepublish'] = 'echo skip';
  fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n');
  run(`npx vsce package --no-dependencies -o ${distDir}`, { cwd: appDir });
} finally {
  const j = JSON.parse(origText);
  if (savedPrepublish === undefined) delete j.scripts['vscode:prepublish'];
  else j.scripts['vscode:prepublish'] = savedPrepublish;
  fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n');
}

const vsix = fs.readdirSync(distDir).filter((f) => f.endsWith('.vsix'));
console.log(`[package-dist] 完成: ${vsix.map((f) => path.join(distDir, f)).join(', ')}`);
