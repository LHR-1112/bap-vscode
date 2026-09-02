// esbuild 构建脚本：打包插件源码 + 历史 webview（Lit）两个 bundle。
// 用法：node esbuild.js [--watch] [--production]
const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const extEntry = 'src/extension.ts';
const viewEntry = path.join('..', '..', 'packages', 'vscode-host', 'src', 'history', 'webview', 'history-app.ts');
const mcpEntry = path.join('..', '..', 'packages', 'vscode-host', 'src', 'mcp', 'mcp-server.ts');

async function main() {
  const ctxExt = await esbuild.context({
    entryPoints: [extEntry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
    sourcemap: !production,
    minify: production,
  });

  const ctxView = await esbuild.context({
    entryPoints: [viewEntry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome100',
    outfile: 'dist/history-view.js',
    sourcemap: !production,
    minify: production,
  });

  // MCP server：宿主外独立进程，bundled 成 CJS，运行时用 node <dist/mcp-server.js> 拉起。
  const ctxMcp = await esbuild.context({
    entryPoints: [mcpEntry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/mcp-server.js',
    external: ['bufferutil', 'utf-8-validate'],
    sourcemap: !production,
    minify: production,
  });

  if (watch) {
    await ctxExt.watch();
    await ctxView.watch();
    await ctxMcp.watch();
    console.log('[esbuild] watching...');
  } else {
    await ctxExt.rebuild();
    await ctxView.rebuild();
    await ctxMcp.rebuild();
    await ctxExt.dispose();
    await ctxView.dispose();
    await ctxMcp.dispose();
    console.log('[esbuild] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
