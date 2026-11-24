#!/usr/bin/env bash
# Build caad-mcp for every supported system into dist/, and copy them to the app's download folder.
# Needs Go (see mise.toml). Small static binaries, no runtime needed on the user's machine.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist ../app/public/bridge
for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  os=${target%/*}; arch=${target#*/}
  out="dist/caad-mcp-$os-$arch$([ "$os" = windows ] && echo .exe || true)"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$out" .
  echo "$out  $(( $(wc -c < "$out") / 1000000 )) MB"
done
cp dist/caad-mcp-* ../app/public/bridge/
