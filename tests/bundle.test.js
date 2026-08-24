import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('bundle patch mounts the plugin', () => {
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /-\s+id:\s+gemini-aistudio/)
  assert.match(patch, /name:\s+dsh-gemini-aistudio/)
})

test('package exposes metadata and a browser-loadable client bundle', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const client = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id:\s*['"]dsh-gemini-aistudio['"]/)
  assert.match(client, /conversation\.input\.left/)
  assert.match(client, /data-gemini-attachment-menu/)
  assert.match(client, /添加图片/)
  assert.match(client, /添加 PDF/)
  assert.match(client, /dispatchNativeImages/)
  assert.match(client, /body:\s*file/)
  assert.match(client, /clipboardData/)
  assert.match(client, /text\/uri-list/)
  assert.match(client, /accept:\s*['"]\.pdf,application\/pdf['"]/)
  assert.match(client, /accept:\s*['"]image\/png,image\/jpeg,image\/webp,image\/gif['"]/)
  assert.doesNotMatch(client, /图片会沿用/)
  assert.doesNotMatch(client, /\.arrayBuffer\(\)/)
  assert.doesNotMatch(client, /\bbtoa\(/)
  assert.equal(fs.existsSync(path.join(root, 'patch-dsh-model-discovery.ps1')), true)
})
