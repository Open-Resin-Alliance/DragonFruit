#!/usr/bin/env bash
# Checks that every Rust file tracked by this repository is formatted with the
# pinned rustfmt. Read-only by default (this is what CI runs); --fix formats.
#
#   scripts/check-rust-format.sh            # check, exit 1 on unformatted files
#   scripts/check-rust-format.sh --fix      # format them
#
# Use this instead of `cargo fmt`, which follows `mod` and `#[path]` into the
# plugin submodules. Each file goes to rustfmt on stdin, so it formats that file
# only, and `git ls-files` does not list what the submodules contain.
set -u

fix=0
case "${1:-}" in
  "") ;;
  --fix) fix=1 ;;
  -h | --help)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown option: $1 (try --help)" >&2
    exit 2
    ;;
esac

cd "$(git rev-parse --show-toplevel)" || exit 2

if ! rustfmt --version >/dev/null 2>&1; then
  echo "rustfmt is not available. Run: rustup component add rustfmt" >&2
  exit 2
fi

# On GitHub, report as annotations; locally, plain text.
report() { # file title message
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error file=$1,title=$2::$3"
  else
    echo "error: $1: $2. $3" >&2
  fi
}

# The edition of the nearest Cargo.toml above a file. Sources outside any crate
# (the in-tree plugins) are compiled into 2021 crates.
edition_of() { # file
  local dir edition
  dir=$(dirname "$1")
  while [ "$dir" != . ]; do
    if [ -f "$dir/Cargo.toml" ]; then
      edition=$(sed -n 's/^edition *= *"\([0-9]*\)".*/\1/p' "$dir/Cargo.toml" | head -n 1)
      echo "${edition:-2021}"
      return
    fi
    dir=$(dirname "$dir")
  done
  echo 2021
}

formatted=$(mktemp) || exit 2
trap 'rm -f "$formatted"' EXIT

fail=0
while IFS= read -r -d '' file; do
  edition=$(edition_of "$file")
  if ! rustfmt --edition "$edition" --emit stdout <"$file" >"$formatted"; then
    report "$file" "rustfmt failed" "See the rustfmt output above"
    fail=1
  elif ! cmp -s "$file" "$formatted"; then
    if [ "$fix" = 1 ]; then
      # Overwrite in place, so the file keeps its mode.
      cat "$formatted" >"$file"
      echo "formatted $file"
    else
      report "$file" "Not formatted" "Run: npm run check:rust-format:fix"
      diff -u "$file" "$formatted" | tail -n +3
      fail=1
    fi
  fi
done < <(git ls-files -z '*.rs')
exit $fail
