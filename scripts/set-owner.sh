#!/usr/bin/env bash
#
# Reassign a group's owner by calling the operator-only XRPC procedure
# app.certified.group.admin.setOwner over HTTP (HTTP Basic auth, user "admin",
# against the service CGS_ADMIN_PASSWORD). This is the supported way to change a
# group's owner; it replaces the old practice of editing the SQLite databases
# directly. See docs/api-reference.md (Admin operations).
#
# The previous owner is demoted to admin; the new owner is promoted in place if
# already a member, or added as a new owner member if not (operator recovery
# when the incumbent owner is unavailable). The change is applied in-process and
# audit-logged; no service restart is needed.
#
# Usage:
#   scripts/set-owner.sh --url URL --repo GROUP --new-owner DID_OR_HANDLE [options]
#
#   -u, --url URL          CGS base URL, e.g. https://dev.groups.certified.app (required)
#   -r, --repo GROUP       Target group: handle or DID (required)
#   -n, --new-owner ID     New owner: handle or DID (required)
#       --password PW      Admin password (default: $CGS_ADMIN_PASSWORD)
#       --dry-run          Print the request that would be sent, but do NOT send it
#   -y, --yes              Skip the confirmation prompt (for automation)
#   -h, --help             Show this help
#
# Auth:
#   The admin password is read from the CGS_ADMIN_PASSWORD environment variable
#   by default (so it stays out of your shell history); pass --password only if
#   you must. It is sent via curl's --user, i.e. HTTP Basic as user "admin".
#
# Requires: curl. (jq is used for nicer output if present, but not required.)
set -euo pipefail

URL=""
REPO=""
NEW_OWNER=""
PASSWORD="${CGS_ADMIN_PASSWORD:-}"
DRY_RUN=false
ASSUME_YES=false

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
err() { echo "Error: $*" >&2; exit 2; }
# Ensure a value-taking flag actually has a value (so `--url` as the last token
# fails with a clear message instead of an `unbound variable` crash under set -u).
need() { [ "$2" -gt 1 ] || err "$1 requires a value."; }

while [ $# -gt 0 ]; do
  case "$1" in
    -u | --url) need "$1" "$#"; URL="$2"; shift 2 ;;
    -r | --repo) need "$1" "$#"; REPO="$2"; shift 2 ;;
    -n | --new-owner) need "$1" "$#"; NEW_OWNER="$2"; shift 2 ;;
    --password) need "$1" "$#"; PASSWORD="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -y | --yes) ASSUME_YES=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || err "curl not found on PATH."
[ -n "$URL" ] || err "--url is required."
[ -n "$REPO" ] || err "--repo is required."
[ -n "$NEW_OWNER" ] || err "--new-owner is required."
[ -n "$PASSWORD" ] || err "admin password not set — pass --password or set CGS_ADMIN_PASSWORD."

URL="${URL%/}" # strip a trailing slash
ENDPOINT="$URL/xrpc/app.certified.group.admin.setOwner"
BODY="$(printf '{"repo":"%s","newOwner":"%s"}' "$REPO" "$NEW_OWNER")"

if [ -n "${CGS_ADMIN_PASSWORD:-}" ] && [ "$PASSWORD" = "${CGS_ADMIN_PASSWORD:-}" ]; then
  pw_source='CGS_ADMIN_PASSWORD'
else
  pw_source='--password'
fi

echo "Plan:"
echo "  endpoint  : POST $ENDPOINT"
echo "  repo      : $REPO"
echo "  new owner : $NEW_OWNER"
echo "  auth      : HTTP Basic (user 'admin', password from $pw_source)"

if $DRY_RUN; then
  echo
  echo "--dry-run: request body would be: $BODY"
  echo "Re-run without --dry-run to apply."
  exit 0
fi

if ! $ASSUME_YES; then
  echo
  printf 'Reassign owner of %s to %s? [y/N] ' "$REPO" "$NEW_OWNER"
  read -r reply
  case "$reply" in
    y | Y | yes | YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# Capture the body and the HTTP status. The status is appended after a newline
# sentinel so we can split them without a temp file.
#
# The credential is fed to curl via `--config -` (stdin) rather than `--user` on
# the command line, so the password never appears in the process arguments
# (readable via `ps` / /proc/<pid>/cmdline while the request runs). curl's
# config format takes `user = "<value>"`; a literal `"` or `\` in the password
# would need escaping, but generated CGS_ADMIN_PASSWORDs are base64url (no such
# characters).
response="$(
  printf 'user = "admin:%s"\n' "$PASSWORD" | curl -sS -X POST "$ENDPOINT" \
    --config - \
    -H 'Content-Type: application/json' \
    -d "$BODY" \
    -w $'\n%{http_code}'
)"

http_code="${response##*$'\n'}"
json="${response%$'\n'*}"

if [ "$http_code" = "200" ]; then
  echo
  echo "Success (HTTP 200)."
  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -r '
      "  owner          : \(.owner)",
      "  previous owner : \(.previousOwner // "(none)")",
      "  added as member: \(.addedAsMember // false)",
      "  no-op          : \(.noop // false)",
      "  updated at     : \(.updatedAt)"
    '
  else
    echo "  $json"
  fi
  exit 0
fi

echo >&2
echo "Failed (HTTP $http_code)." >&2
echo "  $json" >&2
case "$http_code" in
  401) echo "  → Check the admin password, and that CGS_ADMIN_PASSWORD is set on the service." >&2 ;;
  400) echo "  → newOwner may be a malformed DID or an unresolvable handle (InvalidRequest)." >&2 ;;
  404) echo "  → repo does not resolve to a managed group (UnknownGroup)." >&2 ;;
esac
exit 1
