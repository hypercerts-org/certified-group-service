#!/bin/sh
# Resolve the group service version and write it to .cgs-version in the
# current directory. Used by the Dockerfile during image build.
#
# Sources (first non-empty wins):
#   1. RAILWAY_GIT_COMMIT_SHA env var (injected by Railway at build time)
#   2. .cgs-version file already present (written by stamp-version.sh)
#   3. Fails with an actionable error
set -e

if [ -n "$RAILWAY_GIT_COMMIT_SHA" ]; then
  VERSION=$(node -p "require('./package.json').version")
  echo "$VERSION+$(echo "$RAILWAY_GIT_COMMIT_SHA" | cut -c1-8)" > .cgs-version
  exit 0
fi

if [ ! -f .cgs-version ]; then
  echo "ERROR: .cgs-version not found. Run ./scripts/stamp-version.sh before building." >&2
  exit 1
fi

if [ ! -s .cgs-version ]; then
  echo "ERROR: .cgs-version exists but is empty. Re-run ./scripts/stamp-version.sh." >&2
  exit 1
fi
