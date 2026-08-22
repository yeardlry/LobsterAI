'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`[sync-ccbt-runtime-current] ${message}`);
  process.exit(1);
}

const targetId = (process.argv[2] || '').trim();
if (!targetId) {
  fail('Missing target id. Usage: node scripts/sync-ccbt-runtime-current.cjs <target-id>');
}

const rootDir = path.resolve(__dirname, '..');
const runtimeBaseDir = path.join(rootDir, 'vendor', 'ccbt-runtime');
const targetRuntimeDir = path.join(runtimeBaseDir, targetId);
const currentRuntimeDir = path.join(runtimeBaseDir, 'current');

if (!fs.existsSync(targetRuntimeDir)) {
  fail(`Target runtime does not exist: ${targetRuntimeDir}`);
}
if (!fs.existsSync(path.join(targetRuntimeDir, 'dist', 'cli.js'))) {
  fail(`Target runtime is missing dist/cli.js: ${targetRuntimeDir}`);
}

// Remove existing current (handle both real dirs and symlinks/junctions safely).
try {
  const stat = fs.lstatSync(currentRuntimeDir);
  if (stat.isSymbolicLink()) {
    // Junction (Windows) or symlink (macOS/Linux) - unlink without following.
    fs.unlinkSync(currentRuntimeDir);
  } else {
    fs.rmSync(currentRuntimeDir, { recursive: true, force: true });
  }
} catch (_e) {
  // Does not exist - nothing to remove.
}

// Use a directory junction (Windows) or symlink (macOS/Linux) instead of
// copying 600+ dist chunk files.  This is near-instant.
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
fs.symlinkSync(targetRuntimeDir, currentRuntimeDir, linkType);

console.log(`[sync-ccbt-runtime-current] Synced ${targetId} -> vendor/ccbt-runtime/current`);
