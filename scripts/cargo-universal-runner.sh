#!/bin/sh
#
# Cargo runner for the macOS Tauri build (`build.runner` in
# src-tauri/tauri.macos.conf.json). The Tauri CLI calls it exactly as it would
# call cargo: `cargo-universal-runner.sh build|run <args...>`.
#
# For `--target universal-apple-darwin` the Tauri CLI runs two `cargo build`
# calls one after the other, aarch64 then x86_64, and lipos the results. With
# fat LTO and one codegen unit each link is a single-threaded rustc of several
# minutes, so the x86_64 link waits for the aarch64 one while the other cores
# sit idle. When this sees the aarch64 call of a universal build, it builds both
# targets in that one cargo invocation instead, which runs the two links side by
# side.
#
# The x86_64 call that follows must then not reach cargo. Tauri's context macro
# writes the compressed frontend assets into OUT_DIR while the crate compiles,
# after cargo has taken the crate's dep-info, so a fresh build always looks
# stale to the very next cargo call and would compile the app a second time.
# The aarch64 call leaves a marker holding the arguments it built x86_64 with,
# and the x86_64 call skips cargo only if its own arguments match.
#
# A universal build is recognised by DF_BUILD_TARGET_TRIPLE, which every path
# that builds one already sets (scripts/tauri-build.mjs --universal, and the
# release, preview and PR-check workflows). Anything else, `tauri dev` included,
# is handed straight to cargo. `exec` keeps it that way: the process Tauri
# watches and kills is cargo itself, not a shell wrapped around it.

if [ "$1" != build ] || [ "$DF_BUILD_TARGET_TRIPLE" != universal-apple-darwin ]; then
  exec cargo "$@"
fi

marker="${CARGO_TARGET_DIR:-target}/x86_64-apple-darwin/.universal-runner-built"
args=$(printf '%s\n' "$@")

case "$args" in
  *"
aarch64-apple-darwin"*)
    rm -f "$marker"
    cargo "$@" --target x86_64-apple-darwin || exit $?
    printf '%s\n' "$args" | sed 's/^aarch64-apple-darwin$/x86_64-apple-darwin/' > "$marker"
    exit 0
    ;;
  *"
x86_64-apple-darwin"*)
    if [ -f "$marker" ] && [ "$(cat "$marker")" = "$args" ]; then
      rm -f "$marker"
      echo "x86_64-apple-darwin was built alongside aarch64-apple-darwin; skipping cargo"
      exit 0
    fi
    ;;
esac

exec cargo "$@"
