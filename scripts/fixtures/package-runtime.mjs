import assert from 'node:assert/strict'

import * as api from '@midra/webext'

for (const name of [
  'createWebExt',
  'createMainWorldStorage',
  'createMainWorldMessaging',
  'MessageTimeoutError',
  'RemoteError',
  'UnsupportedOperationError',
]) {
  assert.equal(typeof api[name], 'function', `Missing runtime export: ${name}`)
}
assert.equal(typeof api.webext, 'object', 'Missing lazy webext export')
assert.throws(() => api.createWebExt(), /WebExtension context/)
