import type { CreateWebExtOptions } from '../src'

import { expect, mock, test } from 'bun:test'

import { MessageTimeoutError, RemoteError, createWebExt } from '../src'

function bus() {
  type Sender = { id: string; tab: { id: number; windowId: number } }
  type Listener = (
    message: unknown,
    sender: Sender,
    respond: (response: unknown) => void
  ) => unknown
  const listeners = new Set<Listener>()
  const runtime = {
    id: 'test',
    getURL: (path: string) =>
      `chrome-extension://test/${path.startsWith('/') ? path.slice(1) : path}`,
    getManifest: () => ({}),
    onMessage: {
      addListener: (listener: Listener) => {
        listeners.add(listener)
      },
      removeListener: (listener: Listener) => {
        listeners.delete(listener)
      },
    },
    sendMessage: mock(
      (message: unknown) =>
        new Promise((resolve, reject) => {
          let handled = false
          for (const listener of listeners) {
            if (
              listener(
                message,
                { id: 'test', tab: { id: 12, windowId: 3 } },
                resolve
              ) === true
            )
              handled = true
          }
          if (!handled) reject(new Error('No receiver'))
        })
    ),
  }
  return { runtime, listeners }
}
function create(
  api: unknown,
  context?: CreateWebExtOptions['context'],
  url?: string
) {
  return createWebExt({ api: api as CreateWebExtOptions['api'], context, url })
}

test('typed requests preserve synchronous invocation, propagate errors and clean up listeners', async () => {
  const { runtime, listeners } = bus()
  const webext = create({ runtime })
  interface Schema {
    double: { request: number; response: number }
    fail: { request: null; response: null }
  }
  const channel = webext.messaging.channel<Schema>('app')
  let invoked = false
  const stop = channel.handle('double', (number) => {
    invoked = true
    return number * 2
  })
  channel.handle('fail', () => {
    throw new TypeError('Invalid input')
  })
  const result = channel.send('double', 4)
  expect(invoked).toBe(true)
  expect(await result).toBe(8)
  await expect(channel.send('fail', null)).rejects.toBeInstanceOf(RemoteError)
  stop()
  expect(listeners.size).toBe(1)
  webext.dispose()
  expect(listeners.size).toBe(0)
})

test.each([
  {
    label: 'a null-prototype throw',
    thrown: (): unknown => Object.create(null),
    remoteName: 'Error',
    message: 'Remote handler failed',
  },
  ...(['name', 'message'] as const).map((property) => ({
    label: `an Error with a throwing ${property} getter`,
    thrown: (): unknown =>
      Object.defineProperty(new Error('Unavailable'), property, {
        get() {
          throw new Error('Getter failed')
        },
      }),
    remoteName: 'Error',
    message: 'Remote handler failed',
  })),
  {
    label: 'an ordinary Error',
    thrown: (): unknown => new TypeError('Invalid input'),
    remoteName: 'TypeError',
    message: 'Invalid input',
  },
  {
    label: 'a string throw',
    thrown: (): unknown => 'Rejected input',
    remoteName: 'Error',
    message: 'Rejected input',
  },
])('normalizes $label into a RemoteError', async (scenario) => {
  const { runtime } = bus()
  const webext = create({ runtime })
  const channel = webext.messaging.channel<{
    fail: { request: null; response: null }
  }>('app')
  channel.handle('fail', () => {
    throw scenario.thrown()
  })
  try {
    const result = channel.send('fail', null, { timeoutMs: 100 })
    await expect(result).rejects.toBeInstanceOf(RemoteError)
    await expect(result).rejects.toMatchObject({
      remoteName: scenario.remoteName,
      message: scenario.message,
    })
  } finally {
    webext.dispose()
  }
})

test('stop is one-shot when the same handler function is re-registered', async () => {
  const { runtime, listeners } = bus()
  const webext = create({ runtime })
  const channel = webext.messaging.channel<{
    double: { request: number; response: number }
  }>('app')
  const handler = mock((value: number) => value * 2)
  try {
    const oldStop = channel.handle('double', handler)
    expect(listeners.size).toBe(1)
    oldStop()
    expect(listeners.size).toBe(0)
    oldStop()
    expect(listeners.size).toBe(0)

    const newStop = channel.handle('double', handler)
    const listener = [...listeners][0]
    oldStop()
    expect(listeners.size).toBe(1)
    expect(listeners.has(listener!)).toBe(true)
    expect(await channel.send('double', 4)).toBe(8)
    expect(handler).toHaveBeenCalledTimes(1)

    newStop()
    newStop()
    expect(listeners.size).toBe(0)
  } finally {
    webext.dispose()
  }
})

test.each(['request', 'response'] as const)(
  'encoding a %s snapshots each object and array getter exactly once',
  async (direction) => {
    const { runtime } = bus()
    const webext = create({ runtime })
    const channel = webext.messaging.channel<{
      echo: { request: unknown; response: unknown }
    }>('app')
    let reads = 0
    let nestedReads = 0
    let arrayReads = 0
    let omittedReads = 0
    const array = Object.defineProperty([], '0', {
      enumerable: true,
      get: () => ++arrayReads,
    })
    const value = {
      get value() {
        return ++reads === 1 ? 'first' : new Date(0)
      },
      nested: {
        get value() {
          return ++nestedReads
        },
      },
      array,
      get omitted() {
        return ++omittedReads === 1 ? undefined : 'unexpected'
      },
    }
    channel.handle('echo', (request) =>
      direction === 'request' ? request : value
    )
    try {
      const result = await channel.send(
        'echo',
        direction === 'request' ? value : null
      )
      expect(result).toEqual({
        value: 'first',
        nested: { value: 1 },
        array: [1],
      })
      expect(result).not.toBe(value)
      expect([reads, nestedReads, arrayReads, omittedReads]).toEqual([
        1, 1, 1, 1,
      ])
    } finally {
      webext.dispose()
    }
  }
)

test.each(['request', 'response'] as const)(
  'encoding a %s rejects unsupported getter values on their first read',
  async (direction) => {
    const { runtime } = bus()
    const webext = create({ runtime })
    const channel = webext.messaging.channel<{
      echo: { request: unknown; response: unknown }
    }>('app')
    let response: unknown
    channel.handle('echo', (request) =>
      direction === 'request' ? request : response
    )
    try {
      for (const unsupported of [
        new Date(0),
        new Map(),
        new Set(),
        new RegExp('pattern'),
        new Uint8Array([1]),
        Object.create({ inherited: true }),
      ]) {
        let reads = 0
        const value = {
          get value() {
            return ++reads === 1 ? unsupported : 'valid on a later read'
          },
        }
        response = value
        const count = runtime.sendMessage.mock.calls.length
        const result = channel.send(
          'echo',
          direction === 'request' ? value : null
        )
        await expect(result).rejects.toBeInstanceOf(
          direction === 'request' ? TypeError : RemoteError
        )
        if (direction === 'response') {
          await expect(result).rejects.toMatchObject({
            remoteName: 'TypeError',
          })
        }
        expect(reads).toBe(1)
        expect(runtime.sendMessage.mock.calls.length).toBe(
          count + (direction === 'request' ? 0 : 1)
        )
      }
    } finally {
      webext.dispose()
    }
  }
)

test('top-level undefined requests and responses remain undefined', async () => {
  const { runtime } = bus()
  const webext = create({ runtime })
  const channel = webext.messaging.channel<{
    empty: { request: undefined; response: undefined }
  }>('app')
  const handler = mock((request: undefined) => request)
  channel.handle('empty', handler)
  try {
    expect(await channel.send('empty', undefined)).toBeUndefined()
    expect(handler).toHaveBeenCalledWith(undefined, expect.anything())
    expect(runtime.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      empty: true,
      payload: null,
    })
    expect(await runtime.sendMessage.mock.results[0]?.value).toMatchObject({
      empty: true,
      value: null,
    })
  } finally {
    webext.dispose()
  }
})

test.each(['request', 'response'] as const)(
  'encoding a %s preserves null-prototype __proto__ keys without pollution',
  async (direction) => {
    const { runtime } = bus()
    const webext = create({ runtime })
    const channel = webext.messaging.channel<{
      echo: { request: unknown; response: Record<string, unknown> }
    }>('app')
    const value = Object.create(null) as Record<string, unknown>
    value.__proto__ = { polluted: true }
    value.nested = Object.assign(Object.create(null), { kept: 'value' })
    value.omitted = undefined
    channel.handle('echo', (request) =>
      direction === 'request' ? (request as Record<string, unknown>) : value
    )
    try {
      const result = await channel.send(
        'echo',
        direction === 'request' ? value : null
      )
      expect(result).toEqual({
        ['__proto__']: { polluted: true },
        nested: { kept: 'value' },
      })
      expect(Object.hasOwn(result, '__proto__')).toBe(true)
      expect(result.__proto__).toEqual({ polluted: true })
      expect(result.polluted).toBeUndefined()
      expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
    } finally {
      webext.dispose()
    }
  }
)

test.each(['request', 'response'] as const)(
  'encoding a %s supports shared references but rejects object and array cycles',
  async (direction) => {
    const { runtime } = bus()
    const webext = create({ runtime })
    const channel = webext.messaging.channel<{
      echo: { request: unknown; response: unknown }
    }>('app')
    let reads = 0
    const shared = {
      get kept() {
        return ++reads === 1 ? 'value' : new Date(0)
      },
      omitted: undefined,
    }
    let value: unknown = { left: shared, right: shared }
    channel.handle('echo', (request) =>
      direction === 'request' ? request : value
    )
    try {
      expect(
        await channel.send('echo', direction === 'request' ? value : null)
      ).toEqual({ left: { kept: 'value' }, right: { kept: 'value' } })
      expect(reads).toBe(1)

      const objectCycle: Record<string, unknown> = {}
      objectCycle.self = objectCycle
      const arrayCycle: unknown[] = []
      arrayCycle.push(arrayCycle)
      for (const cycle of [objectCycle, arrayCycle]) {
        value = cycle
        const count = runtime.sendMessage.mock.calls.length
        const result = channel.send(
          'echo',
          direction === 'request' ? cycle : null
        )
        await expect(result).rejects.toBeInstanceOf(
          direction === 'request' ? TypeError : RemoteError
        )
        await expect(result).rejects.toThrow('cycles')
        expect(runtime.sendMessage.mock.calls.length).toBe(
          count + (direction === 'request' ? 0 : 1)
        )
      }
    } finally {
      webext.dispose()
    }
  }
)

test.each(['request', 'response'] as const)(
  'encoding a %s serializes array holes as null but rejects explicit undefined',
  async (direction) => {
    const { runtime } = bus()
    const webext = create({ runtime })
    const channel = webext.messaging.channel<{
      echo: { request: unknown; response: unknown }
    }>('app')
    const sparse = new Array(3)
    sparse[1] = 'kept'
    let value: unknown = sparse
    channel.handle('echo', (request) =>
      direction === 'request' ? request : value
    )
    try {
      expect(
        await channel.send('echo', direction === 'request' ? value : null)
      ).toEqual([null, 'kept', null])
      for (const explicit of [[undefined], ['kept', undefined]]) {
        value = explicit
        const count = runtime.sendMessage.mock.calls.length
        const result = channel.send(
          'echo',
          direction === 'request' ? explicit : null
        )
        await expect(result).rejects.toBeInstanceOf(
          direction === 'request' ? TypeError : RemoteError
        )
        if (direction === 'response') {
          await expect(result).rejects.toMatchObject({
            remoteName: 'TypeError',
          })
        }
        expect(runtime.sendMessage.mock.calls.length).toBe(
          count + (direction === 'request' ? 0 : 1)
        )
      }
    } finally {
      webext.dispose()
    }
  }
)

test('timeouts must be positive, finite and at most 2_147_483_647 before sending', async () => {
  const { runtime } = bus()
  const webext = create({ runtime })
  const channel = webext.messaging.channel<{
    echo: { request: number; response: number }
  }>('app')
  channel.handle('echo', (value) => value)
  try {
    for (const timeoutMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2_147_483_648,
      Number.MAX_VALUE,
    ]) {
      await expect(
        channel.send('echo', 4, { timeoutMs })
      ).rejects.toBeInstanceOf(TypeError)
      expect(runtime.sendMessage).not.toHaveBeenCalled()
    }
  } finally {
    webext.dispose()
  }
})

test('the maximum timeout is valid for an immediately responding handler', async () => {
  const { runtime } = bus()
  const webext = create({ runtime })
  const channel = webext.messaging.channel<{
    echo: { request: number; response: number }
  }>('app')
  channel.handle('echo', (value) => value)
  try {
    expect(await channel.send('echo', 4, { timeoutMs: 2_147_483_647 })).toBe(4)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
  } finally {
    webext.dispose()
  }
})

test('background bridge returns the content script own tab and scopes active-tab lookup to its window', async () => {
  const { runtime, listeners } = bus()
  const query = mock(async (_options: unknown) => [{ id: 7, windowId: 3 }])
  const background = create({ runtime, tabs: { query } }, 'background')
  const content = create({ runtime }, 'content-script', 'https://example.org/')
  expect(content.tabs.available).toBe(false)
  expect(await content.tabs.getSelfId()).toBe(12)
  expect(await content.tabs.getTargetId()).toBe(12)
  expect(await content.tabs.getCurrentActiveId()).toBe(7)
  expect(query).toHaveBeenCalledWith({ active: true, windowId: 3 })
  content.dispose()
  background.dispose()
  expect(listeners.size).toBe(0)
})

test('message waits are bounded and invalid JSON is rejected before sending', async () => {
  const { runtime } = bus()
  runtime.sendMessage = mock(() => new Promise(() => {}))
  const webext = create({ runtime })
  const channel = webext.messaging.channel<{
    wait: { request: unknown; response: null }
  }>('app')
  await expect(
    channel.send('wait', null, { timeoutMs: 5 })
  ).rejects.toBeInstanceOf(MessageTimeoutError)
  const count = runtime.sendMessage.mock.calls.length
  await expect(channel.send('wait', new Map())).rejects.toBeInstanceOf(
    TypeError
  )
  expect(runtime.sendMessage.mock.calls.length).toBe(count)
  const controller = new AbortController()
  controller.abort(new Error('Cancelled'))
  await expect(
    channel.send('wait', null, { signal: controller.signal })
  ).rejects.toThrow('Cancelled')
  webext.dispose()
})
