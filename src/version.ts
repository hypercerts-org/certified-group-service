import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// src/version.ts → dist/version.js: both sit one level under the repo root,
// so the root is always the parent directory of this module.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Resolve the group service version string.
 *
 * Precedence:
 *   1. `CGS_VERSION` env var (operator override, e.g. `0.1.0+abcdef01`)
 *   2. `.cgs-version` file written at Docker build time
 *   3. `version` field from the root `package.json` (dev / non-Docker)
 *
 * Throws if none of the above can be resolved — this indicates a broken
 * build or missing repo root, not a condition to silently degrade from.
 */
export function getVersion(): string {
  if (process.env.CGS_VERSION) {
    return process.env.CGS_VERSION
  }

  try {
    const v = readFileSync(join(ROOT, '.cgs-version'), 'utf8').trim()
    if (v) return v
  } catch {
    // .cgs-version not present — fall through to package.json
  }

  const pkgPath = join(ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return pkg.version
}
