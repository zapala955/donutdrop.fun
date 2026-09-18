#!/usr/bin/env bash
set -euo pipefail

# Compares the Cloudflare ranges pinned in infra/caddy/Caddyfile against the published lists.
#
# The Caddyfile refuses any connection that does not come from one of those ranges, so a list that
# has fallen behind is an outage rather than a warning: a range Cloudflare adds later arrives at an
# origin that turns it away, and the site goes dark for everybody that data centre serves — while
# every dashboard involved reports green.
#
# It reports and exits non-zero. It deliberately does not rewrite anything: the file it would be
# editing is the one that decides who may reach the origin, and that is not a change to make
# unattended.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
caddyfile="$repo_root/infra/caddy/Caddyfile"

if [[ ! -f "$caddyfile" ]]; then
  echo "Missing $caddyfile" >&2
  exit 1
fi

published="$(mktemp)"
configured="$(mktemp)"
trap 'rm -f "$published" "$configured"' EXIT

if ! {
  curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4
  printf '\n'
  curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6
  printf '\n'
} | tr -d '\r' | grep -E '^[0-9A-Fa-f:.]+/[0-9]+$' | sort -u > "$published"; then
  echo "Could not fetch the published Cloudflare ranges" >&2
  exit 1
fi

if [[ ! -s "$published" ]]; then
  echo "Published Cloudflare ranges came back empty; refusing to compare against nothing" >&2
  exit 1
fi

# Only the trusted_proxies line: the two matcher lines repeat the same values, and reading one
# source keeps a mismatch between them visible rather than averaged away.
sed -n 's/.*trusted_proxies static //p' "$caddyfile" \
  | tr ' \t' '\n\n' \
  | grep -E '^[0-9A-Fa-f:.]+/[0-9]+$' \
  | sort -u > "$configured"

missing="$(comm -23 "$published" "$configured" || true)"
extra="$(comm -13 "$published" "$configured" || true)"

status=0
if [[ -n "$missing" ]]; then
  echo "Cloudflare publishes ranges this origin would REFUSE:" >&2
  printf '  %s\n' $missing >&2
  status=1
fi
if [[ -n "$extra" ]]; then
  echo "Pinned here but no longer published by Cloudflare:" >&2
  printf '  %s\n' $extra >&2
  status=1
fi

if [[ "$status" -eq 0 ]]; then
  echo "Cloudflare ranges match ($(wc -l < "$published" | tr -d ' ') entries)."
else
  echo >&2
  echo "Update both the trusted_proxies line and the two @direct matcher lines in" >&2
  echo "$caddyfile, then: sudo cp infra/caddy/Caddyfile /etc/caddy/Caddyfile" >&2
  echo "                 sudo caddy validate --config /etc/caddy/Caddyfile" >&2
  echo "                 sudo systemctl reload caddy" >&2
fi
exit "$status"
