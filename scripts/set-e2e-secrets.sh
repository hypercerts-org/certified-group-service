#!/usr/bin/env bash
#
# Push the e2e account config from a dotenv-style file into GitHub Actions
# repository config, so the E2E workflow (.github/workflows/e2e.yml) can run.
#
# Only the passwords are SECRETS. The account identifiers (public atproto
# handles/DIDs) and the service DID are non-sensitive, so they go in as
# repository VARIABLES (vars.*), which the workflow reads accordingly.
#
# Usage:
#   scripts/set-e2e-secrets.sh [ENV_FILE] [--repo OWNER/REPO] [--dry-run]
#
#   ENV_FILE    dotenv file to read (default: e2e/.env)
#   --repo      target repo (default: gh's current repo)
#   --dry-run   print what would be set, without calling gh
#
# Notes:
#   - E2E_CGS_URL and E2E_CGS_SERVICE_DID are intentionally NOT pushed: the
#     workflow tests the PR's Railway preview and derives both from it per run.
#     A fixed value (e.g. copied from a staging-pointed e2e/.env) would mismatch
#     the preview's host and fail with BadJwtAudience.
#   - Blank vars and comment lines are skipped (e.g. unset RBAC accounts).
#   - Values are read literally; surrounding single/double quotes are stripped.
#
# Requires: gh (authenticated, with repo admin to write secrets + variables).
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

# SECRETS — credentials only.
SECRETS="
E2E_GROUP_IMPORTER_PASSWORD
E2E_GROUP_IMPORTER_APP_PASSWORD
E2E_GROUP_OWNER_PASSWORD
E2E_GROUP_ADMIN_PASSWORD
E2E_GROUP_MEMBER_PASSWORD
E2E_GROUP_OUTSIDER_PASSWORD
"

# VARIABLES — public, non-sensitive values. (E2E_CGS_SERVICE_DID is NOT here:
# the workflow derives it per preview deployment; see the skip below.)
VARIABLES="
E2E_GROUP_IMPORTER_IDENTIFIER
E2E_GROUP_OWNER_IDENTIFIER
E2E_GROUP_ADMIN_IDENTIFIER
E2E_GROUP_MEMBER_IDENTIFIER
E2E_GROUP_OUTSIDER_IDENTIFIER
"

# Classify a key as "secret", "variable", or "" (unrecognised).
classify() {
  if printf '%s\n' "$SECRETS" | grep -qx "$1"; then
    echo secret
  elif printf '%s\n' "$VARIABLES" | grep -qx "$1"; then
    echo variable
  else
    echo ""
  fi
}

# `--app actions` is explicit (not relying on the default) so secrets are
# unambiguously GitHub *Actions* repository secrets, never Dependabot/Codespaces.
secret_args=(secret set --app actions)
variable_args=(variable set)
if [ -n "$REPO" ]; then
  secret_args+=(--repo "$REPO")
  variable_args+=(--repo "$REPO")
fi

secret_count=0
var_count=0
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

  # Both of these are derived per-deployment by the workflow, NOT pushed: the
  # `run` job tests the PR's Railway PREVIEW, whose host (and thus did:web)
  # differs per PR. A fixed value copied from a staging-pointed e2e/.env would
  # mismatch the preview and fail every run with `BadJwtAudience`. The workflow
  # sets E2E_CGS_URL from the resolved preview URL and leaves E2E_CGS_SERVICE_DID
  # unset so env.ts derives `did:web:<preview host>`.
  if [ "$key" = "E2E_CGS_URL" ] || [ "$key" = "E2E_CGS_SERVICE_DID" ]; then
    echo "skip      $key (derived per-deployment by the workflow)"
    skip_count=$((skip_count + 1))
    continue
  fi
  # Local-only vars the workflow never consumes — intentionally not pushed.
  case "$key" in
    E2E_GROUP_IMPORTER_APP_PASSWORD_NAME | REGISTER_HANDLE)
      echo "skip      $key (local-only; not used by the workflow)"
      skip_count=$((skip_count + 1))
      continue
      ;;
  esac

  kind="$(classify "$key")"
  if [ -z "$kind" ]; then
    echo "skip      $key (not a recognised e2e var)"
    skip_count=$((skip_count + 1))
    continue
  fi
  if [ -z "$value" ]; then
    echo "skip      $key (empty)"
    skip_count=$((skip_count + 1))
    continue
  fi

  if [ "$kind" = secret ]; then
    if $DRY_RUN; then
      echo "would set secret   $key"
    else
      printf '%s' "$value" | gh "${secret_args[@]}" "$key"
      echo "set       secret   $key"
    fi
    secret_count=$((secret_count + 1))
  else
    if $DRY_RUN; then
      echo "would set variable $key"
    else
      gh "${variable_args[@]}" "$key" --body "$value"
      echo "set       variable $key"
    fi
    var_count=$((var_count + 1))
  fi
done < "$ENV_FILE"

echo "---"
prefix="$( $DRY_RUN && echo 'would set' || echo 'set')"
echo "$prefix $secret_count secret(s) and $var_count variable(s); skipped $skip_count."
