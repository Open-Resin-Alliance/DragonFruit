#!/usr/bin/env bash
#
# Slicing benchmark suite — drives the DragonFruit CLI over a matrix of
# .voxl fixtures × printer profiles × layer heights × AA presets, optionally
# across several git versions/branches/PRs of the software, and optionally
# validating each sliced output against a known-good reference archive.
#
# Each run slices exactly like the UI would for that printer (resolution,
# bit-depth packing, non-square pixel pitch, named AA preset, dithering) and
# records the full SliceStatsV3 perf block plus CPU/RAM (RSS + peak) into a
# JSONL results file — one row per case. Every row is tagged with the git
# `ref`/`git_sha` it was produced by, so results across versions stay
# comparable.
#
# Usage:
#   scripts/bench/run-slicing-bench.sh [options]
#
# Options (all have defaults):
#   --fixtures <dir>     dir of *.voxl scenes         (default: scripts/bench/fixtures)
#   --printers <dir>     dir of *.json printer profiles (default: scripts/bench/printers)
#   --mesh-dir <dir>     STL mesh dir for the voxls    (default: <fixtures>)
#   --layer-heights CSV  e.g. 0.05,0.03               (default: 0.05)
#   --aa-presets CSV     sharp,balanced,smooth,raw    (default: sharp,balanced,smooth,raw)
#   --out <file>         JSONL output                 (default: bench-results.jsonl)
#   --repeats N          runs per case, averaged      (default: 1)
#   --no-build           skip cargo build
#
#  Git multi-version options (measure several versions of the software):
#   --refs CSV           git refs to benchmark: branches/tags/commits, e.g. main,dev,v1.2.0
#   --prs CSV            GitHub PR numbers, e.g. 418,424 (fetched via pull/N/head)
#   --worktree-base DIR  where to create per-ref worktrees   (default: a temp dir)
#   --keep-worktrees     don't delete the worktrees on exit (for inspection)
#   --install-deps       run `npm ci` in each worktree instead of symlinking node_modules
#   --overlay-uncommitted apply the current working-tree diff (git diff HEAD) onto each
#                        worktree before building — use this to benchmark refs that don't
#                        yet contain the bench harness (e.g. before it is merged)
#
#  Validation options (compare output to a known-good slice):
#   --validate <dir>     dir of golden files named <voxl>__<printer>__lh<lh>__<preset>.<ext>;
#                        each case is compared to its golden. For zip formats (.nanodlp) the
#                        per-layer PNG content is hashed (container metadata ignored); for
#                        binary formats (.ctb/.goo/.aff/.azf) the whole file is SHA-256 compared.
#                        Records validation:{status,method,...} on the row.
#   --require-golden     treat a missing golden reference as a case failure (ok=false)
#
#  Hardware sweep (run the whole matrix under several simulated machines):
#   --hw-configs LIST    ';'-separated hardware envelopes, each "name:cpus=N,mem=SIZE", OR a
#                        built-in preset group referenced as "@name". Presets: @pis (a few
#                        Raspberry Pis), @pcs (low-end→workstation), @common (= @pis;@pcs).
#                        e.g.  "@common"  or  "@pis; workstation:cpus=16,mem=32G".
#                        cpus=N pins the run to N cores via `taskset` (the slicing engine sizes
#                        its rayon pools from available_parallelism(), so it genuinely behaves
#                        like an N-core box). mem=SIZE imposes a hard RAM ceiling via a transient
#                        systemd user scope (MemoryMax + no swap); a breach OOM-kills the slice and
#                        is logged as a failure for that machine. Either key may be omitted (a
#                        config with neither = the unconstrained host). Every row is tagged
#                        hw / hw_cpus / hw_mem.
#                        DEFAULT: "@common" — the whole matrix is swept across common PC + Pi
#                        machines. Pass "--hw-configs host" for a single unconstrained run, or an
#                        explicit list. (If the host can't enforce the caps, the default degrades
#                        to a single "host" run with a warning; an explicit list hard-fails.)
#
# Output format per case follows the printer profile's display.outputFormat (nanodlp/ctb/goo/…);
# nanodlp is a zip of layer PNGs (fully introspectable), the others are proprietary binary
# containers (correctness gate falls back to a non-empty-file check — see --validate for content).
#
# When neither --refs nor --prs is given, the current working tree is used (as before).
# The driver/harness (this script, fixtures, printers, goldens) always runs from the
# invoking checkout; only the software-under-test (Rust CLI + TS CLI + src/) varies per ref.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FIXTURES="scripts/bench/fixtures"
PRINTERS="scripts/bench/printers"
MESH_DIR=""
LAYER_HEIGHTS="0.05"
AA_PRESETS="sharp,balanced,smooth,raw"
OUT="bench-results.jsonl"
REPEATS=1
DO_BUILD=1
REFS=""
PRS=""
WORKTREE_BASE=""
KEEP_WT=0
INSTALL_DEPS=0
OVERLAY=0
VALIDATE_DIR=""
REQUIRE_GOLDEN=0
HW_CONFIGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixtures) FIXTURES="$2"; shift 2;;
    --printers) PRINTERS="$2"; shift 2;;
    --mesh-dir) MESH_DIR="$2"; shift 2;;
    --layer-heights) LAYER_HEIGHTS="$2"; shift 2;;
    --aa-presets) AA_PRESETS="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --repeats) REPEATS="$2"; shift 2;;
    --no-build) DO_BUILD=0; shift;;
    --refs) REFS="$2"; shift 2;;
    --prs) PRS="$2"; shift 2;;
    --worktree-base) WORKTREE_BASE="$2"; shift 2;;
    --keep-worktrees) KEEP_WT=1; shift;;
    --install-deps) INSTALL_DEPS=1; shift;;
    --overlay-uncommitted) OVERLAY=1; shift;;
    --validate) VALIDATE_DIR="$2"; shift 2;;
    --require-golden) REQUIRE_GOLDEN=1; shift;;
    --hw-configs) HW_CONFIGS="$2"; shift 2;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done

MESH_DIR="${MESH_DIR:-$FIXTURES}"

# Expose V8's gc() to the TS "frontend" so it can actively reclaim the merged
# geometry after handing positions.bin to the Rust slicer — the slice then runs
# with the node process holding ~nothing, keeping the measurement to purely the
# slicing engine's footprint. (The Rust CLI already measures itself via
# getrusage(RUSAGE_SELF); this keeps the whole process tree honest too.)
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--expose-gc"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
if [[ -n "$VALIDATE_DIR" ]]; then
  command -v sha256sum >/dev/null || { echo "sha256sum is required for --validate" >&2; exit 1; }
  # unzip is only needed for zip-format (.nanodlp) goldens; binary formats fall back to
  # whole-file sha256 (see validate_case), so its absence is not fatal. But WITHOUT unzip a
  # zip golden also degrades to whole-file sha256, which is timestamp-sensitive and will
  # report a spurious "mismatch" — warn so the degradation isn't silent.
  command -v unzip >/dev/null || echo "WARN: unzip not found; .nanodlp goldens will be compared by whole-file sha256 (timestamp-sensitive), not per-layer content" >&2
  [[ -d "$VALIDATE_DIR" ]] || { echo "--validate dir not found: $VALIDATE_DIR" >&2; exit 1; }
fi

# ---------------------------------------------------------------------------
# Hardware sweep: parse --hw-configs into parallel arrays HW_LABEL/HW_CPUS/HW_MEM.
# Each config re-runs the whole matrix inside an imposed hardware envelope:
#   cpus=N  -> `taskset -c 0-(N-1)` gives the process (and its Rust slice child) a
#             real N-core affinity mask. The engine derives its rayon pool sizes from
#             std::thread::available_parallelism() (= sched affinity), so this is true
#             core emulation, not an env-var hint.
#   mem=SIZE-> a transient `systemd-run --user --scope` with a hard MemoryMax + no swap.
#             Exceeding it OOM-kills the slice (surfaced as a case failure for that machine).
#
# Built-in preset groups (referenced as @name; approximate real machines). Pi core counts
# reflect current quad-core boards; RAM is the imposed ceiling. PCs span a low-end mini-PC to
# a workstation. cpus are later clamped to the host's nproc. @common is the default sweep.
# ---------------------------------------------------------------------------
declare -A HW_PRESETS=(
  [pis]="rpi-zero2:cpus=4,mem=512M; rpi3b:cpus=4,mem=1G; rpi4:cpus=4,mem=4G; rpi5:cpus=4,mem=8G"
  [pcs]="pc-lowend:cpus=2,mem=4G; pc-budget:cpus=4,mem=8G; pc-mainstream:cpus=8,mem=16G; pc-workstation:cpus=16,mem=32G"
)
HW_PRESETS[common]="${HW_PRESETS[pis]}; ${HW_PRESETS[pcs]}"

# Expand any @preset tokens in a raw --hw-configs string into concrete "name:spec" entries.
expand_hw_presets() { # <raw-hw-configs> -> expanded ';'-joined string
  local out="" part key
  local IFS=';'; read -ra _parts <<< "$1"
  for part in "${_parts[@]}"; do
    part="$(echo "$part" | tr -d '[:space:]')"; [[ -n "$part" ]] || continue
    if [[ "$part" == @* ]]; then
      key="${part#@}"
      [[ -n "${HW_PRESETS[$key]:-}" ]] || { echo "unknown hw preset '@$key' (known: ${!HW_PRESETS[*]})" >&2; exit 2; }
      out="${out:+$out; }${HW_PRESETS[$key]}"
    else
      out="${out:+$out; }$part"
    fi
  done
  printf '%s' "$out"
}

declare -a HW_LABEL HW_CPUS HW_MEM
HOST_CPUS="$(nproc 2>/dev/null || echo 1)"
need_taskset=0; need_systemd=0
# Default to the common PC + Pi sweep; remember it was defaulted so we can degrade gracefully
# (rather than hard-fail) if this host can't actually enforce the caps.
HW_IS_DEFAULT=0
[[ -z "$HW_CONFIGS" ]] && { HW_CONFIGS="@common"; HW_IS_DEFAULT=1; }
HW_CONFIGS="$(expand_hw_presets "$HW_CONFIGS")"

IFS=';' read -ra _hwentries <<< "$HW_CONFIGS"
for entry in "${_hwentries[@]}"; do
  entry="$(echo "$entry" | tr -d '[:space:]')"; [[ -n "$entry" ]] || continue
  local_name="${entry%%:*}"; spec=""
  [[ "$entry" == *:* ]] && spec="${entry#*:}"
  cpus=""; mem=""
  if [[ -n "$spec" ]]; then
    IFS=',' read -ra _kvs <<< "$spec"
    for kv in "${_kvs[@]}"; do
      case "$kv" in
        cpus=*) cpus="${kv#cpus=}";;
        mem=*)  mem="${kv#mem=}";;
        "" ) ;;
        *) echo "WARN: hw-config '$local_name': ignoring unknown key '$kv' (want cpus= / mem=)" >&2;;
      esac
    done
  fi
  if [[ -n "$cpus" ]]; then
    [[ "$cpus" =~ ^[0-9]+$ && "$cpus" -ge 1 ]] || { echo "hw-config '$local_name': cpus must be a positive integer" >&2; exit 2; }
    if (( cpus > HOST_CPUS )); then
      echo "WARN: hw-config '$local_name': cpus=$cpus > host cores ($HOST_CPUS); clamping to $HOST_CPUS" >&2
      cpus="$HOST_CPUS"
    fi
    need_taskset=1
  fi
  [[ -n "$mem" ]] && need_systemd=1
  HW_LABEL+=("$local_name"); HW_CPUS+=("$cpus"); HW_MEM+=("$mem")
done
[[ ${#HW_LABEL[@]} -gt 0 ]] || { echo "--hw-configs parsed to zero configs" >&2; exit 2; }

# Probe whether this host can actually enforce the requested constraints.
hw_can_taskset=1; hw_can_mem=1
[[ "$need_taskset" == 1 ]] && { command -v taskset >/dev/null || hw_can_taskset=0; }
if [[ "$need_systemd" == 1 ]]; then
  if ! command -v systemd-run >/dev/null \
     || ! systemd-run --user --scope --quiet -p MemoryMax=64M -p MemorySwapMax=0 -- true >/dev/null 2>&1; then
    hw_can_mem=0   # no systemd-run, or the memory cgroup controller isn't delegated to the user manager
  fi
fi

if { [[ "$need_taskset" == 1 && "$hw_can_taskset" == 0 ]]; } \
   || { [[ "$need_systemd" == 1 && "$hw_can_mem" == 0 ]]; }; then
  if [[ "$HW_IS_DEFAULT" == 1 ]]; then
    echo "WARN: the default hardware sweep (@common) needs taskset + an enforceable systemd --user" >&2
    echo "      MemoryMax; this host can't provide them, so falling back to a single unconstrained" >&2
    echo "      'host' run. Install util-linux/systemd (with the memory cgroup delegated), or pass" >&2
    echo "      --hw-configs explicitly to force the sweep." >&2
    HW_LABEL=("host"); HW_CPUS=(""); HW_MEM=(""); need_taskset=0; need_systemd=0
  else
    [[ "$need_taskset" == 1 && "$hw_can_taskset" == 0 ]] && echo "taskset (util-linux) is required for hw-configs with cpus=" >&2
    [[ "$need_systemd" == 1 && "$hw_can_mem" == 0 ]] && echo "an enforceable systemd --user MemoryMax is required for hw-configs with mem= (is the memory cgroup controller delegated to your user manager?)" >&2
    exit 1
  fi
fi

# Emit the command-prefix tokens imposing one hardware config's constraints (may be empty).
# Order matters: the systemd scope wraps everything, taskset sets affinity on the wrapped cmd.
hw_prefix_for() { # <cpus-or-empty> <mem-or-empty> -> prints prefix tokens
  local cpus="$1" mem="$2" pre=""
  [[ -n "$mem" ]] && pre="systemd-run --user --scope --quiet -p MemoryMax=$mem -p MemorySwapMax=0 --"
  if [[ -n "$cpus" ]]; then
    local list; (( cpus <= 1 )) && list="0" || list="0-$((cpus-1))"
    pre="${pre:+$pre }taskset -c $list"
  fi
  printf '%s' "$pre"
}

# Map a printer profile's output format to the archive extension the way the app /
# TS CLI does (outputFormatToExt): ctb/nanodlp are named; anything else passes through.
printer_ext() { # <printer.json>
  local fmt
  fmt="$(jq -r '((.display.outputFormat // .outputFormat // "") | tostring | ascii_downcase)' "$1" 2>/dev/null || echo "")"
  case "$fmt" in
    *ctb*)          echo ".ctb";;
    ""|*nanodlp*)   echo ".nanodlp";;
    .*)             echo "$fmt";;
    *)              echo ".$fmt";;
  esac
}

file_size() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo 0; }
is_zip()    { command -v unzip >/dev/null 2>&1 && unzip -l "$1" >/dev/null 2>&1; }

shopt -s nullglob
voxls=("$FIXTURES"/*.voxl)
printers=("$PRINTERS"/*.json)
[[ ${#voxls[@]}   -gt 0 ]] || { echo "No .voxl fixtures in $FIXTURES" >&2; exit 1; }
[[ ${#printers[@]} -gt 0 ]] || { echo "No printer profiles in $PRINTERS" >&2; exit 1; }

IFS=',' read -ra LHS <<< "$LAYER_HEIGHTS"
IFS=',' read -ra AAS <<< "$AA_PRESETS"

: > "$OUT"
runs=0; fails=0
# jq: average an array of repeat rows into one case row. Scalars + every perf
# field are averaged; the time-series samples are kept from the repeat whose
# total_s is closest to the mean (a representative run for over-time diagnosis).
read -r -d '' AVG_JQ <<'JQ' || true
def avg(f): (map(f) | add) / length;
[.[].perf] as $ps
| {
    ref: .[0].ref, git_sha: .[0].git_sha,
    hw: .[0].hw, hw_cpus: .[0].hw_cpus, hw_mem: .[0].hw_mem,
    voxl: .[0].voxl, printer: .[0].printer, format: .[0].format,
    layer_height: .[0].layer_height,
    aa_preset: .[0].aa_preset, x_packing_mode: .[0].x_packing_mode,
    anti_aliasing: .[0].anti_aliasing, dither: .[0].dither,
    triangles: .[0].triangles, layers: .[0].layers,
    layer_count: .[0].layer_count, numeric_layer_count: .[0].numeric_layer_count,
    gate: .[0].gate,
    ok: all(.[]; .ok), file_bytes: .[0].file_bytes,
    repeats: length,
    total_s: avg(.total_s), total_s_min: (map(.total_s) | min), total_s_max: (map(.total_s) | max),
    wall_s: avg(.wall_s), layers_per_second: avg(.layers_per_second),
    cpu_total_s: avg(.cpu_total_s), cpu_percent: avg(.cpu_percent),
    peak_sample_cpu_percent: avg(.peak_sample_cpu_percent),
    peak_rss_mb: avg(.peak_rss_mb), end_rss_mb: avg(.end_rss_mb),
    perf: (($ps[0] | keys_unsorted) | reduce .[] as $k ({}; . + { ($k): (($ps | map(.[$k]) | add) / ($ps | length)) })),
    # Every repeat kept separate and un-averaged: its own timing, CPU, peak RSS, full
    # perf block and RSS/CPU sample series. The scalars above are just a convenience
    # summary — `runs[]` is the source of truth for "how it ran under this config".
    runs: [ .[] | {
      run, ok, total_s, wall_s, layers_per_second,
      cpu_total_s, cpu_percent, peak_sample_cpu_percent,
      peak_rss_mb, end_rss_mb, perf, samples
    } ]
  }
JQ

# ---------------------------------------------------------------------------
# Validation helpers. Two methods, chosen by container:
#  - zip (.nanodlp): content-hash the numeric layer PNGs; container metadata /
#    timestamps are ignored, only per-layer pixel bytes are compared by name.
#  - binary (.ctb/.goo/.aff/.azf): the CLI can't decode these back to rasters,
#    so the whole file is SHA-256 compared (exact match) against the golden.
# ---------------------------------------------------------------------------
hash_layers() { # <zip-archive> -> "<layer>\t<sha256>" per numeric-stem PNG, sorted numerically
  local arc="$1" d; d="$(mktemp -d)"
  if ! unzip -qq -o "$arc" -d "$d" >/dev/null 2>&1; then rm -rf "$d"; return 1; fi
  ( cd "$d" && find . -type f -name '*.png' | while read -r f; do
      local b; b="$(basename "$f" .png)"
      [[ "$b" =~ ^[0-9]+$ ]] || continue           # skip 3d.png / thumbnails
      printf '%s\t%s\n' "$b" "$(sha256sum "$f" | cut -d' ' -f1)"
    done | sort -n )
  rm -rf "$d"
}

find_golden() { # <voxl> <printer> <lh> <preset> -> path or empty
  shopt -s nullglob
  local g=( "$VALIDATE_DIR/$1__$2__lh$3__$4".* )
  shopt -u nullglob
  [[ ${#g[@]} -gt 0 ]] && printf '%s' "${g[0]}"
}

validate_case() { # <produced-file> <voxl> <printer> <lh> <preset> -> prints validation JSON
  local arc="$1" golden; golden="$(find_golden "$2" "$3" "$4" "$5")"
  if [[ -z "$golden" ]]; then
    jq -c -n --arg dir "$VALIDATE_DIR" '{status:"missing", golden:null}'
    return
  fi

  if is_zip "$arc" && is_zip "$golden"; then
    # ---- zip (.nanodlp): per-layer PNG content comparison ----
    local gh ph; gh="$(mktemp)"; ph="$(mktemp)"
    if ! hash_layers "$golden" > "$gh" || ! hash_layers "$arc" > "$ph"; then
      rm -f "$gh" "$ph"
      jq -c -n --arg g "$golden" '{status:"error", method:"layer-hash", golden:$g, detail:"could not extract an archive"}'
      return
    fi
    jq -c -n --arg g "$golden" --rawfile goldp "$gh" --rawfile prodp "$ph" '
      def rows($s): ($s|split("\n")|map(select(length>0))|map(split("\t")|{key:.[0],val:.[1]}));
      (rows($goldp)) as $G | (rows($prodp)) as $P
      | ($G|map(.key)) as $gk | ($P|map(.key)) as $pk
      | ($G|map({(.key):.val})|add // {}) as $gm
      | ($P|map({(.key):.val})|add // {}) as $pm
      | [ $gk[] | select( ($pm[.] != null) and ($pm[.] != $gm[.]) ) ] as $diff
      | [ $gk[] | select( $pm[.] == null ) ] as $only_golden
      | [ $pk[] | select( $gm[.] == null ) ] as $only_produced
      | { status: (if (($diff|length)+($only_golden|length)+($only_produced|length))==0 then "match" else "mismatch" end),
          method: "layer-hash",
          golden: $g,
          layers_compared: ($gk|length),
          mismatched_layers: ($diff|sort|.[0:50]),
          mismatched_count: ($diff|length),
          only_in_golden: ($only_golden|length),
          only_in_produced: ($only_produced|length) }'
    rm -f "$gh" "$ph"
  else
    # ---- binary (.ctb/.goo/.aff/.azf): whole-file exact SHA-256 comparison ----
    local ph gh ps gs
    ph="$(sha256sum "$arc"    | cut -d' ' -f1)"
    gh="$(sha256sum "$golden" | cut -d' ' -f1)"
    ps="$(file_size "$arc")"; gs="$(file_size "$golden")"
    jq -c -n --arg g "$golden" --arg ph "$ph" --arg gh "$gh" \
       --argjson ps "$ps" --argjson gs "$gs" '
      { status: (if $ph==$gh then "match" else "mismatch" end),
        method: "file-sha256",
        golden: $g,
        produced_sha256: $ph, golden_sha256: $gh,
        produced_bytes: $ps, golden_bytes: $gs,
        byte_delta: ($ps - $gs) }'
  fi
}

# ---------------------------------------------------------------------------
# Git target resolution: build a list of (label, sha, ts-cmd, rust-binary).
# A "target" is one version of the software to benchmark. With no --refs/--prs
# there is a single target: the current working tree.
# ---------------------------------------------------------------------------
declare -a TARGET_LABEL TARGET_SHA TARGET_TS TARGET_RUST
WORKTREES=()
CREATED_WT_BASE=0

cleanup_worktrees() {
  if [[ "$KEEP_WT" == 1 ]]; then
    [[ ${#WORKTREES[@]} -gt 0 ]] && echo "==> keeping worktrees: ${WORKTREES[*]}" >&2
    return
  fi
  for wt in "${WORKTREES[@]:-}"; do
    [[ -n "$wt" ]] || continue
    git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
  done
  [[ "$CREATED_WT_BASE" == 1 && -n "$WORKTREE_BASE" ]] && rmdir "$WORKTREE_BASE" 2>/dev/null || true
}
trap cleanup_worktrees EXIT

build_rust() { # <checkout-dir>
  ( cd "$1/rust/dragonfruit-cli" && cargo build --release >/dev/null )
}

if [[ -z "$REFS" && -z "$PRS" ]]; then
  # ---- single target: the current working tree (original behavior) ----
  if [[ "$DO_BUILD" == 1 ]]; then
    echo "==> building dragonfruit-cli (release)" >&2
    build_rust "$REPO_ROOT"
  fi
  rbin="$REPO_ROOT/rust/dragonfruit-cli/target/release/dragonfruit-cli"
  [[ -x "$rbin" ]] || { echo "CLI binary not found: $rbin (drop --no-build or build it)" >&2; exit 1; }
  TARGET_LABEL+=("working-tree")
  TARGET_SHA+=("$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)")
  TARGET_TS+=("npx tsx scripts/dragonfruit-ts-cli.ts")
  TARGET_RUST+=("$rbin")
else
  # ---- multiple targets: one git worktree per ref/PR ----
  if [[ -z "$WORKTREE_BASE" ]]; then WORKTREE_BASE="$(mktemp -d)"; CREATED_WT_BASE=1; fi
  mkdir -p "$WORKTREE_BASE"

  declare -a REFLIST=()
  IFS=',' read -ra _refs <<< "$REFS"; for x in "${_refs[@]}"; do [[ -n "$x" ]] && REFLIST+=("ref:$x"); done
  IFS=',' read -ra _prs  <<< "$PRS";  for x in "${_prs[@]}";  do [[ -n "$x" ]] && REFLIST+=("pr:$x");  done

  for entry in "${REFLIST[@]}"; do
    kind="${entry%%:*}"; val="${entry#*:}"
    if [[ "$kind" == pr ]]; then
      label="pr-$val"
      echo "==> fetching PR #$val" >&2
      if ! git -C "$REPO_ROOT" fetch -q origin "pull/$val/head"; then
        echo "  SKIP pr-$val: git fetch pull/$val/head failed" >&2; continue
      fi
      committish="FETCH_HEAD"
    else
      label="$val"; committish="$val"
    fi

    if ! sha="$(git -C "$REPO_ROOT" rev-parse --short "$committish" 2>/dev/null)"; then
      echo "  SKIP $label: cannot resolve '$committish' (fetch it first?)" >&2; continue
    fi

    safe="$(echo "$label" | tr '/:@ ' '____')"
    wt="$WORKTREE_BASE/$safe"
    echo "==> worktree $label ($sha) -> $wt" >&2
    if ! git -C "$REPO_ROOT" worktree add -q --detach "$wt" "$committish"; then
      echo "  SKIP $label: git worktree add failed" >&2; continue
    fi
    WORKTREES+=("$wt")

    # Node deps: symlink the primary node_modules (fast) or install fresh.
    if [[ "$INSTALL_DEPS" == 1 ]]; then
      echo "  installing node deps for $label" >&2
      ( cd "$wt" && { npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1; } ) \
        || echo "  WARN: npm install failed for $label (TS CLI may not run)" >&2
    else
      ln -s "$REPO_ROOT/node_modules" "$wt/node_modules" 2>/dev/null || true
    fi

    # Optionally overlay the working-tree diff so refs without the bench harness
    # still get instrumented (thin shim over the ref's engine code).
    if [[ "$OVERLAY" == 1 ]]; then
      patch="$wt/.bench-overlay.patch"
      git -C "$REPO_ROOT" diff HEAD > "$patch" 2>/dev/null || true
      if [[ -s "$patch" ]]; then
        if git -C "$wt" apply --3way "$patch" >/dev/null 2>&1; then
          echo "  overlaid uncommitted changes onto $label" >&2
        else
          echo "  WARN: overlay did not apply cleanly on $label — building as-is" >&2
        fi
      fi
    fi

    if [[ "$DO_BUILD" == 1 ]]; then
      echo "  building dragonfruit-cli for $label" >&2
      if ! build_rust "$wt"; then echo "  SKIP $label: cargo build failed" >&2; continue; fi
    fi
    rbin="$wt/rust/dragonfruit-cli/target/release/dragonfruit-cli"
    [[ -x "$rbin" ]] || { echo "  SKIP $label: CLI binary not found (drop --no-build or build it)" >&2; continue; }

    TARGET_LABEL+=("$label")
    TARGET_SHA+=("$sha")
    TARGET_TS+=("npx tsx $wt/scripts/dragonfruit-ts-cli.ts")
    TARGET_RUST+=("$rbin")
  done

  [[ ${#TARGET_LABEL[@]} -gt 0 ]] || { echo "No usable git targets to benchmark" >&2; exit 1; }
fi

# ---------------------------------------------------------------------------
# Run the full fixture × printer × layer-height × AA-preset matrix for one
# target (one version of the software). Rows are tagged with ref/git_sha, and
# optionally carry a validation:{...} block vs a known-good archive.
# ---------------------------------------------------------------------------
run_matrix() { # <label> <sha> <ts-cmd> <rust-binary> <hw-label> <hw-cpus> <hw-mem>
  local REF="$1" SHA="$2" TS="$3" RUST="$4" HWL="$5" HWC="$6" HWM="$7"
  local prefix=""
  [[ ${#TARGET_LABEL[@]} -gt 1 || "$REF" != "working-tree" ]] && prefix="[$REF] "
  [[ ${#HW_LABEL[@]} -gt 1 ]] && prefix="${prefix}{$HWL} "

  # Command prefix that imposes this machine's CPU/RAM envelope on the slice (and its
  # Rust child). Empty for the unconstrained host. The systemd scope, when present, caps
  # the whole process subtree's RAM — the TS frontend already wipes its heap before the
  # blocking slice, so the cap effectively bounds the slicing engine's footprint.
  local HWPRE; HWPRE="$(hw_prefix_for "$HWC" "$HWM")"

  local voxl printer lh aa vname pname pext repfile ok_repeats r tmp errf res insp fsize row rc
  local valjson valfile hwcjson hwmjson
  hwcjson="$([[ -n "$HWC" ]] && printf '%s' "$HWC" || printf 'null')"
  hwmjson="$([[ -n "$HWM" ]] && printf '"%s"' "$HWM" || printf 'null')"
  for voxl in "${voxls[@]}"; do
   for printer in "${printers[@]}"; do
    pext="$(printer_ext "$printer")"        # output format follows the printer profile
    for lh in "${LHS[@]}"; do
     for aa in "${AAS[@]}"; do
      vname="$(basename "$voxl" .voxl)"; pname="$(basename "$printer" .json)"
      repfile="$(mktemp)"; ok_repeats=0; valjson=""; valfile=""
      for ((r=1; r<=REPEATS; r++)); do
        tmp="$(mktemp -u --suffix="$pext")"; errf="$(mktemp)"
        if res="$($HWPRE $TS scene slice "$voxl" --o "$tmp" --mesh-dir "$MESH_DIR" \
                   --printer "$printer" --layer-height "$lh" --aa-preset "$aa" \
                   --json 2>"$errf")"; then
          # print inspect is zip-only; on binary formats (.ctb/.goo/…) it fails and
          # we fall back to a non-empty-file gate. fsize is always available via stat.
          insp="$($RUST print inspect "$tmp" --json 2>/dev/null || echo '{}')"
          fsize="$(file_size "$tmp")"
          jq -c -n --argjson s "$res" --argjson i "$insp" \
                --arg voxl "$vname" --arg printer "$pname" --arg fmt "$pext" \
                --arg lh "$lh" --arg aa "$aa" --argjson r "$r" --argjson fsize "$fsize" \
                --arg ref "$REF" --arg sha "$SHA" \
                --arg hw "$HWL" --argjson hwc "$hwcjson" --argjson hwm "$hwmjson" '
            ($i.numeric_layer_count) as $nlc
            | {
            ref:$ref, git_sha:$sha,
            hw:$hw, hw_cpus:$hwc, hw_mem:$hwm,
            voxl:$voxl, printer:$printer, format:$fmt,
            layer_height:($lh|tonumber), aa_preset:$aa, run:$r,
            layers:$s.layers, layer_count:($i.layer_count // null),
            numeric_layer_count:($nlc // null),
            gate:(if $nlc != null then "numeric-layer-count" else "file-nonempty" end),
            ok:(if $nlc != null then ($nlc == $s.layers) else ($fsize > 0) end),
            x_packing_mode:$s.x_packing_mode, anti_aliasing:$s.anti_aliasing, dither:$s.dither,
            total_s:$s.total_s, wall_s:$s.wall_s, layers_per_second:$s.layers_per_second,
            perf:$s.perf,
            cpu_total_s:$s.resources.cpu_total_s, cpu_percent:$s.resources.cpu_percent,
            peak_sample_cpu_percent:($s.resources.peak_sample_cpu_percent // 0),
            peak_rss_mb:(($s.resources.peak_rss_bytes // 0)/1048576),
            end_rss_mb:(($s.resources.end_rss_bytes // 0)/1048576),
            samples:[ ($s.resources.samples // [])[] | {run:$r} + . ],
            triangles:($s.scene.total_triangles // null), file_bytes:($i.file_size_bytes // $fsize)
          }' >> "$repfile"
          ok_repeats=$((ok_repeats+1))
          # Validate once per case (slicing is deterministic): keep the first
          # good archive for the content comparison, delete the rest.
          if [[ -n "$VALIDATE_DIR" && -z "$valfile" ]]; then valfile="$tmp"; else rm -f "$tmp"; fi
        else
          rc=$?
          fails=$((fails+1))
          # Under a mem cap, a cgroup OOM tears the systemd scope down and the slice exits via a
          # signal (137=SIGKILL or 143=SIGTERM, i.e. rc>128) — a genuine slice error would exit
          # with a small code instead. Flag it so the failure reads as "didn't fit this machine's
          # RAM" rather than a generic error.
          local why=""
          [[ -n "$HWM" && "$rc" -gt 128 ]] && why=" — likely OOM (mem cap=$HWM)"
          echo "  ${prefix}FAILED: $vname / $pname lh=$lh preset=$aa (run $r/$REPEATS, exit $rc)$why" >&2
          tail -n 3 "$errf" | sed 's/^/      | /' >&2
          rm -f "$tmp"
        fi
        rm -f "$errf"
      done

      if [[ -n "$valfile" ]]; then
        valjson="$(validate_case "$valfile" "$vname" "$pname" "$lh" "$aa")"
        rm -f "$valfile"
      fi

      runs=$((runs+1))
      if [[ "$ok_repeats" -gt 0 ]]; then
        row="$(jq -s -c "$AVG_JQ" "$repfile")"
        if [[ -n "$valjson" ]]; then
          row="$(echo "$row" | jq -c --argjson v "$valjson" --argjson req "$REQUIRE_GOLDEN" '
            . + {validation:$v}
            | if ($v.status=="mismatch" or $v.status=="error"
                  or ($req==1 and $v.status=="missing")) then .ok=false else . end')"
        fi
        echo "$row" >> "$OUT"
        printf '  %s%-14s %-20s lh=%-5s preset=%-9s %s\n' "$prefix" "$vname" "$pname" "$lh" "$aa" \
          "$(echo "$row" | jq -r '"\(.format) \(.layers)L avg \(.total_s*10|round/10)s (\(.repeats)x) \(.layers_per_second|round)lps peakRSS=\(.peak_rss_mb|round)MB peakCPU=\(.peak_sample_cpu_percent|round)% dither=\(.dither.enabled)\(if .validation then " valid=\(.validation.status)" else "" end) ok=\(.ok)"')" >&2
      else
        jq -c -n --arg ref "$REF" --arg sha "$SHA" --arg voxl "$vname" --arg printer "$pname" \
          --arg fmt "$pext" --arg lh "$lh" --arg aa "$aa" \
          --arg hw "$HWL" --argjson hwc "$hwcjson" --argjson hwm "$hwmjson" \
          '{ref:$ref,git_sha:$sha,hw:$hw,hw_cpus:$hwc,hw_mem:$hwm,voxl:$voxl,printer:$printer,format:$fmt,layer_height:($lh|tonumber),aa_preset:$aa,error:"all repeats failed"}' >> "$OUT"
        printf '  %s%-14s %-20s lh=%-5s preset=%-9s ERROR (all %s repeats failed)\n' "$prefix" "$vname" "$pname" "$lh" "$aa" "$REPEATS" >&2
      fi
      rm -f "$repfile"
     done
    done
   done
  done
}

# Build once per git target, then sweep every hardware envelope under it (the software
# is fixed per ref; only the imposed CPU/RAM machine changes between hw configs).
for ti in "${!TARGET_LABEL[@]}"; do
  [[ ${#TARGET_LABEL[@]} -gt 1 ]] && echo "==> benchmarking ${TARGET_LABEL[$ti]} (${TARGET_SHA[$ti]})" >&2
  for hi in "${!HW_LABEL[@]}"; do
    if [[ ${#HW_LABEL[@]} -gt 1 || -n "${HW_CPUS[$hi]}${HW_MEM[$hi]}" ]]; then
      echo "==> hw config '${HW_LABEL[$hi]}' (cpus=${HW_CPUS[$hi]:-host} mem=${HW_MEM[$hi]:-unbounded})" >&2
    fi
    run_matrix "${TARGET_LABEL[$ti]}" "${TARGET_SHA[$ti]}" "${TARGET_TS[$ti]}" "${TARGET_RUST[$ti]}" \
               "${HW_LABEL[$hi]}" "${HW_CPUS[$hi]}" "${HW_MEM[$hi]}"
  done
done

echo "==> ${#TARGET_LABEL[@]} target(s) × ${#HW_LABEL[@]} hw config(s), $runs cases, $fails failed repeats -> $OUT" >&2
