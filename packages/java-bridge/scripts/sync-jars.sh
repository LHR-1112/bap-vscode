#!/usr/bin/env bash
# 从生产 IDEA 插件拷贝 JS 桥运行时所需的 jar 到 lib/。
# 采用「全量拷贝 lib/platform/*.jar」（与生产插件 AdminToolLauncher 运行时用法一致），
# 一次性覆盖所有 tcmcat/netty/ecj/guava/reflections 等传递依赖，避免逐个运行时试错。
# 这些 jar 是第三方二进制产物，不纳入 git（见 .gitignore）。
set -euo pipefail

SRC="/Users/lihongrui/IdeaProjects/PluginDemo/lib/platform"
DST="$(cd "$(dirname "$0")/.." && pwd)/lib"

if [ ! -d "$SRC" ]; then
  echo "ERROR: 未找到 jar 源目录 $SRC（生产 IDEA 插件路径）" >&2
  exit 1
fi

mkdir -p "$DST"

count=0
for j in "$SRC"/*.jar; do
  [ -f "$j" ] || continue
  cp -f "$j" "$DST/"
  count=$((count+1))
done

echo "synced $count jars -> $DST"
