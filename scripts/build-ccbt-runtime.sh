#!/usr/bin/env bash
set -euo pipefail

# Build a distributable ccbt (claude-code-best-thank) runtime folder for embedding into Electron.
# Usage:
#   bash scripts/build-ccbt-runtime.sh [target-id]
# Example:
#   CCBT_SRC=/path/to/ccbt bash scripts/build-ccbt-runtime.sh mac-arm64
#
# Output layout (vendor/ccbt-runtime/<target-id>/):
#   bun            # Bun runtime binary (ccbt dist requires Bun; Node cannot run it)
#   dist/          # ccbt build output, code-split chunks (MUST stay split - single
#                  # file bundles blow up Bun/JSC RSS to ~1GB)
#   VERSION        # ccbt package.json version
#   runtime-build-info.json#
# Env:
#   CCBT_SRC         ccbt source checkout (default: clone from package.json ccbt.repo)
#   CCBT_FORCE_BUILD force rebuild even if version cache matches
#   CCBT_SKIP_BUILD  reuse existing dist/ in CCBT_SRC without rebuilding

TARGET_ID="${1:-mac-arm64}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_ROOT="${ELECTRON_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OUT_DIR="${OUT_DIR:-$ELECTRON_ROOT/vendor/ccbt-runtime/$TARGET_ID}"

TARGET_PLATFORM="${TARGET_ID%%-*}"
TARGET_ARCH="${TARGET_ID#*-}"
if [[ "$TARGET_PLATFORM" == "$TARGET_ID" || -z "$TARGET_ARCH" ]]; then
  echo "Invalid target id: $TARGET_ID (expected <platform>-<arch>, e.g. mac-arm64, win-x64, linux-x64)" >&2
  exit 1
fi

case "$TARGET_PLATFORM" in
  mac) BUN_OS="darwin" ;;
  win) BUN_OS="windows" ;;
  linux) BUN_OS="linux" ;;
  *)
    echo "Unsupported target platform in TARGET_ID: $TARGET_PLATFORM" >&2
    exit 1
    ;;
esac

case "$TARGET_ARCH" in
  x64 | arm64) BUN_ARCH="$TARGET_ARCH" ;;
  *)
    echo "Unsupported target arch in TARGET_ID: $TARGET_ARCH" >&2
    exit 1
    ;;
esac

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd node

# Read pinned ccbt version / repo / bun version from LobsterAI package.json.
read_pkg_field() {
  node - "$ELECTRON_ROOT" "$1" <<'READFIELD'
const path = require('path');
try {
  const pkg = require(path.join(process.argv[2], 'package.json'));
  const value = pkg.ccbt && pkg.ccbt[process.argv[3]];
  if (value) console.log(value);
} catch {}
READFIELD
}

CCBT_VERSION="$(read_pkg_field version)"
CCBT_REPO="$(read_pkg_field repo)"
CCBT_BUN_VERSION="$(read_pkg_field bunVersion)"
if [[ -z "$CCBT_VERSION" || -z "$CCBT_BUN_VERSION" ]]; then
  echo "package.json must define ccbt.version and ccbt.bunVersion" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build cache: skip if the runtime was already built for the pinned version.
# ---------------------------------------------------------------------------
if [[ "${CCBT_FORCE_BUILD:-}" != "1" && -f "$OUT_DIR/runtime-build-info.json" ]]; then
  BUILT_VERSION="$(node - "$OUT_DIR/runtime-build-info.json" <<'READBI'
try { const info = require(process.argv[2]); if (info.ccbtVersion) console.log(info.ccbtVersion); } catch {}
READBI
  )"
  BUILT_BUN="$(node - "$OUT_DIR/runtime-build-info.json" <<'READBUN'
try { const info = require(process.argv[2]); if (info.bunVersion) console.log(info.bunVersion); } catch {}
READBUN
  )"
  if [[ "$BUILT_VERSION" == "$CCBT_VERSION" && "$BUILT_BUN" == "$CCBT_BUN_VERSION" ]]; then
    if [[ -f "$OUT_DIR/bun" || -f "$OUT_DIR/bun.exe" ]] && [[ -f "$OUT_DIR/dist/cli.js" ]]; then
      echo "[ccbt-runtime] Already built for $CCBT_VERSION (bun $CCBT_BUN_VERSION, target=$TARGET_ID), skipping."
      echo "[ccbt-runtime] Use CCBT_FORCE_BUILD=1 to force rebuild."
      exit 0
    fi
    echo "[ccbt-runtime] Existing build metadata matches, but runtime layout is incomplete; rebuilding."
  fi
fi

# ---------------------------------------------------------------------------
# Resolve ccbt source: CCBT_SRC env wins, then known local checkout paths,
# otherwise clone the pinned tag from ccbt.repo.
# Note: the clone flow requires a git tag named exactly ccbt.version to exist
# in the repo; until ccbt publishes tags, build from a local checkout.
# ---------------------------------------------------------------------------
CLONE_CACHE="$ELECTRON_ROOT/.ccbt-cache"
if [[ -z "${CCBT_SRC:-}" ]]; then
  for CANDIDATE in "$ELECTRON_ROOT/../claude-code-best-thank" "$ELECTRON_ROOT/../../ClaudeCode/claude-code-best-thank"; do
    if [[ -d "$CANDIDATE" ]]; then
      CCBT_SRC="$CANDIDATE"
      break
    fi
  done
  if [[ -z "${CCBT_SRC:-}" ]]; then
    if [[ -z "$CCBT_REPO" ]]; then
      echo "Neither CCBT_SRC nor package.json ccbt.repo is set, and no default source checkout was found." >&2
      exit 1
    fi
    CCBT_SRC="$CLONE_CACHE/claude-code-best-thank"
    echo "[1/5] Cloning ccbt@$CCBT_VERSION from $CCBT_REPO"
    need_cmd git
    rm -rf "$CLONE_CACHE"
    mkdir -p "$CLONE_CACHE"
    git clone --depth 1 --branch "$CCBT_VERSION" "$CCBT_REPO" "$CCBT_SRC"
  fi
fi

if [[ ! -d "$CCBT_SRC" ]]; then
  echo "CCBT_SRC does not exist: $CCBT_SRC" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build ccbt (skippable when the caller knows dist/ is fresh).
# ---------------------------------------------------------------------------
if [[ "${CCBT_SKIP_BUILD:-}" != "1" || ! -f "$CCBT_SRC/dist/cli.js" ]]; then
  echo "[2/5] Building ccbt from source: $CCBT_SRC"
  need_cmd bun
  pushd "$CCBT_SRC" >/dev/null
  bun install
  bun run build
  popd >/dev/null
fi
if [[ ! -f "$CCBT_SRC/dist/cli.js" ]]; then
  echo "ccbt build did not produce dist/cli.js in $CCBT_SRC" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Obtain the Bun runtime binary for the target platform (cached).
# Priority: host-matching local bun install -> @oven/bun-* npm platform
# package (works with any npm registry mirror, no GitHub access needed).
# ---------------------------------------------------------------------------
BUN_CACHE_DIR="${CCBT_BUN_CACHE:-$CLONE_CACHE/bun-$CCBT_BUN_VERSION-$BUN_OS-$BUN_ARCH}"
BUN_BIN_NAME="bun"
if [[ "$BUN_OS" == "windows" ]]; then
  BUN_BIN_NAME="bun.exe"
fi
HOST_OS_NPM="$(node -e 'console.log(process.platform)')"
HOST_ARCH_NPM="$(node -e 'console.log(process.arch)')"

if [[ ! -f "$BUN_CACHE_DIR/$BUN_BIN_NAME" ]]; then
  if [[ "$HOST_OS_NPM" == "$BUN_OS" && "$HOST_ARCH_NPM" == "$BUN_ARCH" && "$(bun --version 2>/dev/null || true)" == "$CCBT_BUN_VERSION" ]]; then
    echo "[3/5] Copying host Bun $CCBT_BUN_VERSION ($(command -v bun))"
    mkdir -p "$BUN_CACHE_DIR"
    cp "$(command -v bun)" "$BUN_CACHE_DIR/$BUN_BIN_NAME"
    chmod +x "$BUN_CACHE_DIR/$BUN_BIN_NAME"
  else
    echo "[3/5] Fetching @oven/bun-$BUN_OS-$BUN_ARCH@$CCBT_BUN_VERSION from npm"
    need_cmd npm
    WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ccbt-bun.XXXXXX")"
    trap 'rm -rf "$WORK_DIR"' EXIT
    (cd "$WORK_DIR" && npm pack "@oven/bun-$BUN_OS-$BUN_ARCH@$CCBT_BUN_VERSION" --silent)
    TARBALL="$(ls -1 "$WORK_DIR"/*.tgz | head -n 1)"
    if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
      echo "npm pack did not produce a tarball for @oven/bun-$BUN_OS-$BUN_ARCH@$CCBT_BUN_VERSION" >&2
      exit 1
    fi
    (cd "$WORK_DIR" && tar -xzf "$TARBALL")
    if [[ ! -f "$WORK_DIR/package/bin/$BUN_BIN_NAME" ]]; then
      echo "npm package did not contain bin/$BUN_BIN_NAME" >&2
      exit 1
    fi
    mkdir -p "$BUN_CACHE_DIR"
    mv "$WORK_DIR/package/bin/$BUN_BIN_NAME" "$BUN_CACHE_DIR/$BUN_BIN_NAME"
    if [[ "$BUN_OS" != "windows" ]]; then
      chmod +x "$BUN_CACHE_DIR/$BUN_BIN_NAME"
    fi
  fi
else
  echo "[3/5] Bun $CCBT_BUN_VERSION ($BUN_OS-$BUN_ARCH) found in cache"
fi

# ---------------------------------------------------------------------------
# Assemble the runtime dir. Sourcemaps are ~60% of dist size and never needed
# at runtime - exclude them.
# ---------------------------------------------------------------------------
echo "[4/5] Assembling runtime dir: $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$BUN_CACHE_DIR/$BUN_BIN_NAME" "$OUT_DIR/$BUN_BIN_NAME"
if [[ "$BUN_OS" != "windows" ]]; then
  chmod +x "$OUT_DIR/$BUN_BIN_NAME"
fi
# Copy dist/ without *.map files (rsync if available, tar fallback).
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='*.map' "$CCBT_SRC/dist/" "$OUT_DIR/dist/"
else
  (cd "$CCBT_SRC/dist" && tar -cf - --exclude='*.map' .) | (cd "$OUT_DIR" && mkdir -p dist && cd dist && tar -xf -)
fi
printf '%s\n' "$CCBT_VERSION" >"$OUT_DIR/VERSION"

node - "$OUT_DIR" "$CCBT_SRC" "$TARGET_ID" "$CCBT_VERSION" "$CCBT_BUN_VERSION" <<'NODE'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [outDir, src, target, ccbtVersion, bunVersion] = process.argv.slice(2);
let ccbtCommit = '';
try {
  ccbtCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: src,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {}
const meta = { builtAt: new Date().toISOString(), source: src, target, ccbtVersion, ccbtCommit, bunVersion };
fs.writeFileSync(path.join(outDir, 'runtime-build-info.json'), JSON.stringify(meta, null, 2) + '\n');
NODE

# ---------------------------------------------------------------------------
# Verify: run the assembled runtime.
# ---------------------------------------------------------------------------
echo "[5/5] Verifying runtime"
BUN_EXE="$OUT_DIR/$BUN_BIN_NAME"
if [[ "$BUN_OS" == "windows" ]]; then
  # Cross-compiled Windows runtime cannot execute on the build host unless it
  # is itself Windows; only check layout.
  [[ -f "$OUT_DIR/dist/cli.js" ]]
else
  VERSION_OUTPUT="$("$BUN_EXE" "$OUT_DIR/dist/cli.js" --version)"
  if [[ "$VERSION_OUTPUT" != *"$CCBT_VERSION"* ]]; then
    echo "Runtime verification failed: expected version $CCBT_VERSION, got: $VERSION_OUTPUT" >&2
    exit 1
  fi
  echo "[ccbt-runtime] bun cli.js --version -> $VERSION_OUTPUT"
fi

echo "[ccbt-runtime] Done: $OUT_DIR"
