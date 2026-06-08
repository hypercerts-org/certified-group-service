import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getVersion } from '../src/version.js'

// Mirror src/version.ts: repo root is the parent of the src/ (or dist/) dir.
// tests/ sits at the repo root, so root is one level up from this file.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_FILE = join(ROOT, '.cgs-version')
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

describe('getVersion', () => {
  afterEach(() => {
    delete process.env.CGS_VERSION
    rmSync(VERSION_FILE, { force: true })
  })

  it('prefers the CGS_VERSION env override', () => {
    process.env.CGS_VERSION = '1.2.3+deadbeef'
    // A .cgs-version file present must not win over the env var.
    writeFileSync(VERSION_FILE, '0.0.0+fromfile')
    expect(getVersion()).toBe('1.2.3+deadbeef')
  })

  it('falls back to the .cgs-version file when no env override', () => {
    writeFileSync(VERSION_FILE, '4.5.6+abcd1234\n')
    expect(getVersion()).toBe('4.5.6+abcd1234')
  })

  it('ignores an empty .cgs-version file and falls back to package.json', () => {
    writeFileSync(VERSION_FILE, '   \n')
    expect(getVersion()).toBe(PKG_VERSION)
  })

  it('falls back to package.json version when nothing else is set', () => {
    expect(getVersion()).toBe(PKG_VERSION)
  })
})
