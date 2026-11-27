import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

const ROOT = path.resolve(__dirname, '..')

function bashN(file: string): void {
  const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${file}\n${result.stderr}`)
}

describe('shell scripts', () => {
  it('bash -n parses every package script', () => {
    const files = [
      'scripts/render-template.sh',
      'scripts/macos/env.sh',
      'scripts/macos/install.sh',
      'scripts/macos/uninstall.sh',
      'scripts/macos/status.sh',
      'scripts/macos/kiosk-guard.sh',
      'scripts/macos/kiosk-pin-login.sh',
      'scripts/macos/kiosk-allow-camera.sh',
      'scripts/macos/av-lock.sh',
    ]
    for (const rel of files) {
      bashN(path.join(ROOT, rel))
    }
  })

  it('renders LaunchAgent and livekit templates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tpl-'))
    const out = path.join(dir, 'server.plist')
    execFileSync('bash', [
      path.join(ROOT, 'scripts/render-template.sh'),
      path.join(ROOT, 'deploy/launchagents/server.plist.template'),
      out,
      'ROOT=/opt/marshallcam',
      'HOME=/home/demo',
      'LABEL_PREFIX=com.marshallcam',
      'NODE_BIN=/opt/marshallcam/node_modules/.bin/tsx',
      'LOG_DIR=/opt/marshallcam/logs',
    ], { encoding: 'utf8' })
    const plist = fs.readFileSync(out, 'utf8')
    assert.match(plist, /com\.marshallcam\.server/)
    assert.match(plist, /\/opt\/marshallcam\/src\/MarshallCamServer\.ts/)
    assert.doesNotMatch(plist, /\{\{/)

    const yamlOut = path.join(dir, 'livekit.yaml')
    execFileSync('bash', [
      path.join(ROOT, 'scripts/render-template.sh'),
      path.join(ROOT, 'deploy/livekit.yaml.template'),
      yamlOut,
      'LIVEKIT_API_KEY=devkey',
      'LIVEKIT_API_SECRET=devsecret',
    ])
    const yaml = fs.readFileSync(yamlOut, 'utf8')
    assert.match(yaml, /devkey: devsecret/)
    assert.doesNotMatch(yaml, /\{\{/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
