#!/usr/bin/env bash
# Populate .local/browser-deps with the shared libraries + fonts that Chromium
# needs in this container, and install the Chromium build under .local/browsers.
#
# No root required: .deb files are fetched and extracted into a private prefix.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$ROOT/.local/browser-deps"
WORK="${TMPDIR:-/tmp}/rpa-browser-deps"
APT_LISTS="$WORK/apt-lists"
APT_CACHE="$WORK/apt-cache"
ARCH="$(dpkg --print-architecture)"

PACKAGES=(
  libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6
  libexpat1 libxau6 libxdmcp6 libxrender1 libasound2 libatspi2.0-0
  libwayland-server0 libwayland-client0 libxi6 libfontconfig1
  fonts-dejavu-core fonts-liberation2
)

if [[ ! -f "$DEPS/.complete" ]]; then
  echo "[bootstrap] fetching Chromium system dependencies (no root)…"
  mkdir -p "$WORK/debs" "$APT_LISTS/partial" "$APT_CACHE/archives/partial" "$DEPS"
  APT_OPTS=(-o "Dir::State::lists=$APT_LISTS" -o "Dir::Cache=$APT_CACHE" -o Debug::NoLocking=1)
  if [[ ! -f "$APT_LISTS/deb.debian.org_debian_dists_bookworm_InRelease" ]]; then
    apt-get "${APT_OPTS[@]}" update >/dev/null 2>&1 || true
  fi
  ( cd "$WORK/debs" && apt-get "${APT_OPTS[@]}" download "${PACKAGES[@]}" >/dev/null )
  for deb in "$WORK"/debs/*.deb; do dpkg-deb -x "$deb" "$DEPS"; done
  cp -a "$DEPS/usr/share/fonts" "$ROOT/.local/fonts" 2>/dev/null || true
  touch "$DEPS/.complete"
fi

if [[ ! -d "$ROOT/.local/browsers" || -z "$(ls -A "$ROOT/.local/browsers" 2>/dev/null)" ]]; then
  echo "[bootstrap] installing Chromium build…"
  ( cd "$ROOT" && PLAYWRIGHT_BROWSERS_PATH="$ROOT/.local/browsers" npx playwright install chromium )
fi

echo "[bootstrap] ready: $DEPS and $ROOT/.local/browsers"
