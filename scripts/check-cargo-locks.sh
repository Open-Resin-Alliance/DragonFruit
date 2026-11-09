#!/usr/bin/env bash
# Checks that every tracked Cargo.lock matches its Cargo.toml.
# Read-only by default (this is what CI runs); --fix refreshes stale locks.
#
#   scripts/check-cargo-locks.sh            # check, exit 1 if any lock is stale
#   scripts/check-cargo-locks.sh --fix      # also fix them
#
# `cargo update --workspace` only touches entries the manifests no longer
# match, so without --locked it is also the minimal fix.
set -u

fix=0
case "${1:-}" in
  "") ;;
  --fix) fix=1 ;;
  -h | --help)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown option: $1 (try --help)" >&2
    exit 2
    ;;
esac

cd "$(git rev-parse --show-toplevel)" || exit 2

# On GitHub, report as annotations; locally, plain text.
report() { # level file title message
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::$1 file=$2,title=$3::$4"
  else
    echo "$1: $2: $3. $4" >&2
  fi
}

fail=0
for lock in $(git ls-files '*Cargo.lock'); do
  m="${lock%.lock}.toml"
  if err=$(cargo update --workspace --locked --manifest-path "$m" 2>&1 >/dev/null); then
    continue
  fi
  if grep -q -- '--locked was passed' <<<"$err"; then
    if [ "$fix" = 1 ]; then
      if cargo update --workspace --manifest-path "$m" >/dev/null 2>&1; then
        echo "updated $lock"
      else
        report error "$lock" "Cargo.lock could not be refreshed" "Run: cargo update --workspace --manifest-path $m"
        fail=1
      fi
    else
      report error "$lock" "Cargo.lock out of date" "Run: cargo update --workspace --manifest-path $m (or npm run check:cargo-locks:fix)"
      fail=1
    fi
  else
    report error "$lock" "Cargo.lock could not be resolved" "$(grep -m1 '^error' <<<"$err")"
    fail=1
  fi
done
exit $fail
