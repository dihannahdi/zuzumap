#!/bin/bash
# ZuzuMap deploy — run from the repo root (Git Bash on Windows works).
# usage: deploy/deploy.sh frontend|backend|all
set -euo pipefail
HOST=sonushub
DOCROOT=/www/wwwroot/map.nahdi.space
BUILD=/root/kafilah-build

frontend() {
  echo "— frontend → $DOCROOT"
  tar -C static -czf - . | ssh "$HOST" "tar xzf - -C $DOCROOT"
  echo "local sw: $(grep -o 'kafilah-v[0-9]*' static/sw.js | head -1)   live sw: $(curl -s https://map.nahdi.space/sw.js | grep -o 'kafilah-v[0-9]*' | head -1)"
}

backend() {
  echo "— backend: build on $HOST"
  tar czf - src Cargo.toml Cargo.lock | ssh "$HOST" "mkdir -p $BUILD && tar xzf - -C $BUILD"
  ssh "$HOST" "bash -lc 'cd $BUILD && cargo build --release'"
  ssh "$HOST" "systemctl stop kafilah && cp $BUILD/target/release/kafilah /opt/kafilah/kafilah && systemctl start kafilah && sleep 1 && systemctl is-active kafilah && curl -sf http://127.0.0.1:8795/api/health && echo"
}

case "${1:-all}" in
  frontend) frontend ;;
  backend)  backend ;;
  all)      backend; frontend ;;
  *) echo "usage: $0 frontend|backend|all"; exit 1 ;;
esac
echo "done."
