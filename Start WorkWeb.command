#!/bin/bash

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "WorkWeb" message "未找到 Node.js，请先安装 Node.js 后再双击启动。"' >/dev/null 2>&1 || true
  echo "未找到 Node.js，请先安装 Node.js 后再双击启动。"
  read -r -p "按回车关闭..."
  exit 1
fi

node "$DIR/scripts/launch.js"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo
  echo "启动失败，请查看 runtime/workweb-server.log"
  read -r -p "按回车关闭..."
fi

exit "$STATUS"
