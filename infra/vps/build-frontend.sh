#!/usr/bin/env bash
# Builds the frontend nginx serves under /b/ (scripts/build-frontend.mjs) from the checked-out
# source, inside the pinned Node image the API is built from, so the server needs nothing installed.
#
# esbuild is installed once into a docker volume and reused by every later build. If it cannot be
# installed (no registry, a bad download) the build still runs, unminified: the caching and the
# no-mixed-releases guarantee hold either way, only the bytes differ.
#
# deploy.sh runs this on every deploy, and update-and-deploy.sh again after a rollback, so the
# build always matches the checkout. Run it by hand after checking out a commit any other way.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node_image="$(sed -n 's/^FROM \(node:[^ ]*\) AS build$/\1/p' "$repo_root/infra/docker/api.Dockerfile" | head -n 1)"
esbuild_version="0.28.2"

if [[ -z "$node_image" ]]; then
  echo "Could not read the Node image from infra/docker/api.Dockerfile." >&2
  exit 1
fi

docker volume create donutdrop-frontend-tools >/dev/null
docker run --rm \
  -v donutdrop-frontend-tools:/tools \
  -v "$repo_root:/repo" \
  -w /repo \
  -e ESBUILD_DIR=/tools/node_modules \
  -e ESBUILD_VERSION="$esbuild_version" \
  "$node_image" \
  sh -c '
    installed="$(node -p "require(\"/tools/node_modules/esbuild/package.json\").version" 2>/dev/null || true)"
    if [ "$installed" != "$ESBUILD_VERSION" ]; then
      npm install --prefix /tools --no-save --no-audit --no-fund "esbuild@$ESBUILD_VERSION" >/dev/null 2>&1 \
        || echo "esbuild $ESBUILD_VERSION could not be installed; building unminified." >&2
    fi
    node scripts/build-frontend.mjs
  '
