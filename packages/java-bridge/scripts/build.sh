#!/usr/bin/env bash
# 编译 Java 桥并组装运行时产物到 dist/lib。
#   - javac --release 8：产 Java 8 字节码，可在 JDK 8/11/17 运行（本机较新 JDK 亦可编译）
#   - 打 bridge-main.jar（不含平台 jar），平台 jar 复制到 dist/lib，运行时用 -cp ".../lib/*" 通配符
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! ls lib/*.jar >/dev/null 2>&1; then
  echo "ERROR: lib/ 下无 jar，请先运行 npm run sync-jars -w @bap/java-bridge（或在 packages/java-bridge 下运行 npm run sync-jars）" >&2
  exit 1
fi

# 清理旧产物，避免把已删除源码的 class 打进 jar（如历史遗留的 BridgeMain$StreamProgress.class）
rm -rf out dist/lib
mkdir -p out dist/lib

JAVAC=javac
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  JAVAC="$JAVA_HOME/bin/javac"
fi

# 递归收集全部 *.java；argfile 放在 out 之外，避免被打进 jar
ARG_FILE="$(mktemp)"
trap 'rm -f "$ARG_FILE"' EXIT
find src/main/java -name '*.java' -print > "$ARG_FILE"

echo "compiling Java bridge (--release 8)..."
"$JAVAC" --release 8 -encoding UTF-8 -cp 'lib/*' -d out @"$ARG_FILE"

# 打包业务资源（log4j.properties）进 bridge-main.jar，使日志走 stderr
cp resources/log4j.properties out/log4j.properties 2>/dev/null || true

echo "packaging bridge-main.jar..."
jar cfe dist/lib/bridge-main.jar com.bap.dev.BridgeMain -C out .

echo "staging platform jars into dist/lib..."
for j in lib/*.jar; do
  cp -f "$j" dist/lib/
done

echo "bridge built -> dist/lib ($(ls dist/lib/*.jar | wc -l | tr -d ' ') jars)"
