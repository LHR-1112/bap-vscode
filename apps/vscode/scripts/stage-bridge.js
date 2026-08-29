// 把 Java 桥运行时产物（dist/lib/*.jar）拷进 assets/bridge/lib，供 VS Code 插件资产使用。
// 调用链：npm run build:bridge && node scripts/stage-bridge.js && node esbuild.js --production
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const srcLib = path.join(repoRoot, 'packages', 'java-bridge', 'dist', 'lib');
const destLib = path.join(appRoot, 'assets', 'bridge', 'lib');

if (!fs.existsSync(srcLib)) {
  console.error(`[stage-bridge] 未找到 Java 桥产物 ${srcLib}，请先运行 npm run build:bridge`);
  process.exit(1);
}

fs.rmSync(destLib, { recursive: true, force: true });
fs.mkdirSync(destLib, { recursive: true });

const jars = fs.readdirSync(srcLib).filter((f) => f.endsWith('.jar'));
for (const j of jars) {
  fs.copyFileSync(path.join(srcLib, j), path.join(destLib, j));
}
console.log(`[stage-bridge] staged ${jars.length} jars -> ${destLib}`);
