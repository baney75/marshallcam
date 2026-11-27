import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { loadEnvFile, parseEnvFile } from '../src/env'

const tmpDirs: string[] = []

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

describe('env loader', () => {
  it('parses keys, quotes, and comments', () => {
    const parsed = parseEnvFile([
      '# comment',
      'FOO=bar',
      'QUOTED="hello world"',
      "SINGLE='x'",
      '',
      'EXPORT_OK=1',
    ].join('\n'))
    assert.equal(parsed.FOO, 'bar')
    assert.equal(parsed.QUOTED, 'hello world')
    assert.equal(parsed.SINGLE, 'x')
  })

  it('does not override variables already set in the environment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-env-'))
    tmpDirs.push(dir)
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, 'KEEP_ME=from-file\nNEW_ONLY=file\n')
    const env: NodeJS.ProcessEnv = { KEEP_ME: 'already-set' }
    loadEnvFile(file, env)
    assert.equal(env.KEEP_ME, 'already-set')
    assert.equal(env.NEW_ONLY, 'file')
  })

  it('ignores a missing file', () => {
    const env: NodeJS.ProcessEnv = {}
    assert.doesNotThrow(() => loadEnvFile(path.join(os.tmpdir(), 'no-such-marshallcam.env'), env))
  })
})
