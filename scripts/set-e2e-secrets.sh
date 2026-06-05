#!/usr/bin/env bash
#
# Push the e2e account credentials from a dotenv-style file into GitHub Actions
# repository secrets, so the E2E workflow (.github/workflows/e2e.yml) can run.
#
# Usage:
#   scripts/set-e2e-secrets.sh [ENV_FILE] [--repo OWNER/REPO] [--dry-run]
#
#   ENV_FILE    dotenv file to read (default: e2e/.env)
#   --repo      target repo (default: gh's current repo)
#   --dry-run   print what would be set, without calling gh
#
# Notes:
#   - CGS_URL is intentionally NOT pushed: the workflow derives the service URL
#     from the Railway deployment, so a CGS_URL secret would be ignored/stale.
#   - Blank vars and comment lines are skipped (e.g. unset RBAC accounts).
#   - Values are read literally; surrounding single/double quotes are stripped.
#
# Requires: gh (authenticated, with repo admin to write secrets).
set -euo pipefail

ENV_FILE="e2e/.env"
REPO=""
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) ENV_FILE="$1"; shift ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 2
fi

# Secrets the workflow consumes (see .github/workflows/e2e.yml). CGS_URL is
# deliberately excluded — the workflow derives it from the Railway deployment.
ALLOWED="
CGS_SERVICE_DID
IMPORTER_IDENTIFIER
IMPORTER_PASSWORD
IMPORTER_APP_PASSWORD
GROUP_OWNER_IDENTIFIER
GROUP_OWNER_PASSWORD
ADMIN_IDENTIFIER
ADMIN_PASSWORD
MEMBER_IDENTIFIER
MEMBER_PASSWORD
OUTSIDER_IDENTIFIER
OUTSIDER_PASSWORD
"

is_allowed() {
  printf '%s\n' "$ALLOWED" | grep -qx "$1"
}

gh_args=(secret set)
[ -n "$REPO" ] && gh_args+=(--repo "$REPO")

set_count=0
skip_count=0

while IFS= read -r line || [ -n "$line" ]; do
  # Strip leading/trailing whitespace.
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  # Skip blanks and comments.
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  # Must be KEY=VALUE.
  case "$line" in *=*) ;; *) continue ;; esac

  key="${line%%=*}"
  value="${line#*=}"
  # Strip one layer of surrounding quotes.
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac

  if [ "$key" = "CGS_URL" ]; then
    echo "skip  $key (derived from the Railway deployment, not a secret)"
    skip_count=$((skip_count + 1))
    continue
  fi
  if ! is_allowed "$key"; then
    echo "skip  $key (not a recognised e2e secret)"
    skip_count=$((skip_count + 1))
    continue
  fi
  if [ -z "$value" ]; then
    echo "skip  $key (empty)"
    skip_count=$((skip_count + 1))
    continue
  fi

  if $DRY_RUN; then
    echo "would set  $key"
  else
    printf '%s' "$value" | gh "${gh_args[@]}" "$key"
    echo "set   $key"
  fi
  set_count=$((set_count + 1))
done < "$ENV_FILE"

echo "---"
echo "$( $DRY_RUN && echo 'would set' || echo 'set') $set_count secret(s); skipped $skip_count."
