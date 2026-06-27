#!/usr/bin/env bash
#
# Generate a strong CGS_ADMIN_PASSWORD with openssl and set it on a Railway
# environment/service via the Railway CLI. CGS_ADMIN_PASSWORD enables the
# operator-only app.certified.group.admin.* endpoints (HTTP Basic auth); when
# unset those endpoints are disabled. See docs/deployment.md#admin-endpoints.
#
# Usage:
#   scripts/set-cgs-admin-password.sh --environment ENV --service SVC [options]
#
#   -e, --environment ENV   Railway environment (required, e.g. staging)
#   -s, --service SVC       Railway service (required, e.g. certified-group-service)
#   -p, --project ID        Railway project (defaults to the linked project)
#       --length N          openssl random bytes before encoding (default: 32,
#                           yielding a ~43-char base64url password; min 12)
#       --skip-deploys      Pass --skip-deploys to Railway (do not redeploy now)
#       --show              Print the generated password ONCE to stderr
#       --dry-run           Generate + print the plan, but do NOT set anything
#   -y, --yes               Skip the confirmation prompt (for automation)
#   -h, --help              Show this help
#
# Security:
#   - The password is piped to Railway via `variable set --stdin`, so it never
#     appears on the command line, in the process list, or in shell history.
#   - It is NOT printed unless you pass --show. Railway stores it; retrieve it
#     later with `railway variable list -k` if needed.
#   - Setting a variable is a MUTATING action on a live environment. The script
#     confirms before doing so unless --yes is given.
#
# Requires: openssl, and an authenticated Railway CLI (`railway whoami`).
set -euo pipefail

ENVIRONMENT=""
SERVICE=""
PROJECT=""
LENGTH=32
SKIP_DEPLOYS=false
SHOW=false
DRY_RUN=false
ASSUME_YES=false

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
err() { echo "Error: $*" >&2; exit 2; }
# Ensure a value-taking flag actually has a value (so `--environment` as the
# last token fails clearly instead of an `unbound variable` crash under set -u).
need() { [ "$2" -gt 1 ] || err "$1 requires a value."; }

while [ $# -gt 0 ]; do
  case "$1" in
    -e | --environment) need "$1" "$#"; ENVIRONMENT="$2"; shift 2 ;;
    -s | --service) need "$1" "$#"; SERVICE="$2"; shift 2 ;;
    -p | --project) need "$1" "$#"; PROJECT="$2"; shift 2 ;;
    --length) need "$1" "$#"; LENGTH="$2"; shift 2 ;;
    --skip-deploys) SKIP_DEPLOYS=true; shift ;;
    --show) SHOW=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -y | --yes) ASSUME_YES=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || err "openssl not found on PATH."
command -v railway >/dev/null 2>&1 || err "railway CLI not found on PATH."
[ -n "$ENVIRONMENT" ] || err "--environment is required."
[ -n "$SERVICE" ] || err "--service is required."
case "$LENGTH" in
  '' | *[!0-9]*) err "--length must be a positive integer (bytes)." ;;
esac
[ "$LENGTH" -ge 12 ] || err "--length must be at least 12 bytes (the config requires >= 16 chars)."

# Confirm the CLI is authenticated up front, with a clear message rather than a
# cryptic failure mid-run.
railway whoami >/dev/null 2>&1 || err "Railway CLI is not authenticated. Run: railway login"

# Generate a URL-safe, whitespace-free password: base64, then map +/ to -_ and
# strip = padding and any newline. This satisfies the >= 16 non-whitespace
# requirement enforced by src/config.ts.
PASSWORD="$(openssl rand -base64 "$LENGTH" | tr '+/' '-_' | tr -d '=\n')"
[ "${#PASSWORD}" -ge 16 ] || err "generated password is shorter than 16 chars (unexpected)."

PROJECT_ARGS=()
[ -n "$PROJECT" ] && PROJECT_ARGS=(--project "$PROJECT")
SKIP_ARGS=()
$SKIP_DEPLOYS && SKIP_ARGS=(--skip-deploys)

echo "Plan:"
echo "  variable    : CGS_ADMIN_PASSWORD"
echo "  environment : $ENVIRONMENT"
echo "  service     : $SERVICE"
[ -n "$PROJECT" ] && echo "  project     : $PROJECT"
echo "  length      : ${#PASSWORD} chars (from $LENGTH random bytes)"
$SKIP_DEPLOYS && echo "  deploys     : skipped (--skip-deploys)" \
  || echo "  deploys     : Railway will redeploy the service"
$SHOW && echo "  password    : $PASSWORD" >&2

if $DRY_RUN; then
  echo
  echo "--dry-run: nothing was set. Re-run without --dry-run to apply."
  exit 0
fi

if ! $ASSUME_YES; then
  echo
  printf 'Set CGS_ADMIN_PASSWORD on %s/%s now? [y/N] ' "$ENVIRONMENT" "$SERVICE"
  read -r reply
  case "$reply" in
    y | Y | yes | YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# Pipe the value via --stdin so it never lands on the command line.
printf '%s' "$PASSWORD" | railway variable set CGS_ADMIN_PASSWORD --stdin \
  --environment "$ENVIRONMENT" --service "$SERVICE" "${PROJECT_ARGS[@]}" "${SKIP_ARGS[@]}"

echo
echo "Done. CGS_ADMIN_PASSWORD is set on $ENVIRONMENT/$SERVICE."
# Mirror --project in the read-back hint so it reads the same project that was
# just written, not the (possibly different) linked default.
readback="railway variable list -k -e $ENVIRONMENT -s $SERVICE"
[ -n "$PROJECT" ] && readback="$readback -p $PROJECT"
$SHOW || echo "(Password not shown. Re-run with --show next time, or read it back with: $readback)"
