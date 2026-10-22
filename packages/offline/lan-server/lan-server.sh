#!/usr/bin/env bash
# One command for offline mode 1 (F550): builds the LAN server image and serves a site build, offline packages and
# static tile folders on the local network. Needs only Docker.
#
#   lan-server.sh [--site <dir>] [--packages <dir>] [--tiles <dir>] [--port <port>] [--name <container>] [--detach]
#
# Defaults: the playground's production build (apps/playground/dist), no packages, no tiles, port 8080.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
site="$repo/apps/playground/dist"
packages=""
tiles=""
port=8080
name=vibeglobe-lan-server
detach=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site) site="$2"; shift 2 ;;
    --packages) packages="$2"; shift 2 ;;
    --tiles) tiles="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --detach) detach="--detach"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "lan-server: unknown option $1" >&2; exit 2 ;;
  esac
done
[[ -d "$site" ]] || { echo "lan-server: no site build at $site (run npm run build)" >&2; exit 1; }
mounts=(--volume "$(cd "$site" && pwd):/srv/site:ro")
[[ -n "$packages" ]] && mounts+=(--volume "$(cd "$packages" && pwd):/srv/packages:ro")
[[ -n "$tiles" ]] && mounts+=(--volume "$(cd "$tiles" && pwd):/srv/tiles:ro")
docker build --quiet --tag vibeglobe-lan-server "$here" >/dev/null
docker rm --force "$name" >/dev/null 2>&1 || true
echo "VibeGlobe LAN server on http://0.0.0.0:$port/ (site $site${packages:+, packages $packages}${tiles:+, tiles $tiles})"
exec docker run --rm $detach --name "$name" --publish "0.0.0.0:$port:8080" "${mounts[@]}" vibeglobe-lan-server
