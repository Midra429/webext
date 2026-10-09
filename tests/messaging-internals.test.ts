import type Browser from 'webextension-polyfill'
import type { MessagingApi, SendOptions } from '../src/messaging'

import { expect, mock, spyOn, test } from 'bun:test'

import { MessageTimeoutError, RemoteError } from '../src/errors'
import { createMessaging } from '../src/messaging'
import { encode } from '../src/messaging/serialization'

interface Schema {
  echo: { request: unknown; response: unknown }
  double: { request: number; response: number }
}
type Listener = (
  message: unknown,
  sender: Browser.Runtime.MessageSender,
  respond?: (response: unknown) => void
) => boolean

function bus() {
  const listeners = new Set<Listener>()
  const onMessage = {
    addListener: mock(function (this: unknown, listener: Listener) {
      expect(this).toBe(onMessage)
      listeners.add(listener)
    }),
    removeListener: mock(function (this: unknown, listener: Listener) {
      expect(this).toBe(onMessage)
      listeners.delete(listener)
    }),
  }
  const runtime = {
    id: 'test',
    onMessage,
    sendMessage: mock(
      (message: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          let handled = false
          for (const listener of listeners) {
            if (listener(message, { id: 'test' }, resolve) === true)
              handled = true
          }
          if (!handled) reject(new Error('No receiver'))
        })
    ),
  }
  const api = { runtime } as unknown as MessagingApi
  return { runtime, listeners, api }
}

const request = {
  __webext_rpc__: 1,
  channel: 'app',
  type: 'echo',
  payload: 'value',
  empty: false,
}
const response = { __webext_rpc__: 1, ok: true, value: 'value' }

test('multiple channels and types share one synchronously registered listener', async () => {
  const { api, runtime, listeners } = bus()
  const messaging = createMessaging(api)
  const first = messaging.channel<Schema>('first')
  const second = messaging.channel<Schema>('second')
  expect(messaging.channel<Schema>('first')).toBe(first)
  expect(listeners.size).toBe(0)
  let invoked = false
  const stopFirst = first.handle('double', (value) => {
    invoked = true
    return value * 2
  })
  expect(listeners.size).toBe(1)
  const listener = [...listeners][0]
  const stopEcho = first.handle('echo', (value) => value)
  const stopSecond = second.handle('double', (value) => value * 3)
  try {
    expect(listeners.size).toBe(1)
    expect(runtime.onMessage.addListener).toHaveBeenCalledTimes(1)
    const result = first.send('double', 4)
    expect(invoked).toBe(true)
    expect(await result).toBe(8)
    expect(await second.send('double', 4)).toBe(12)
    expect(await first.send('echo', 'first')).toBe('first')
    expect(() => first.handle('double', (value) => value)).toThrow(
      'already registered'
    )
    stopFirst()
    stopEcho()
    expect(listeners.size).toBe(1)
    expect(listeners.has(listener!)).toBe(true)
    expect(runtime.onMessage.removeListener).not.toHaveBeenCalled()
    expect(await second.send('double', 5)).toBe(15)
    stopSecond()
    expect(listeners.size).toBe(0)
    expect(runtime.onMessage.removeListener).toHaveBeenCalledTimes(1)
    const stopAgain = second.handle('echo', (value) => value)
    expect(listeners.size).toBe(1)
    expect(listeners.has(listener!)).toBe(true)
    expect(runtime.onMessage.addListener).toHaveBeenCalledTimes(2)
    stopAgain()
    expect(listeners.size).toBe(0)
  } finally {
    messaging.dispose()
  }
})

test('channel disposal and stale one-shot stops leave other and recreated channels intact', async () => {
  const { api, runtime, listeners } = bus()
  const messaging = createMessaging(api)
  const first = messaging.channel<Schema>('first')
  const second = messaging.channel<Schema>('second')
  const handler = (value: number) => value * 2
  const staleStop = first.handle('double', handler)
  const stopSecond = second.handle('double', handler)
  try {
    first.dispose()
    first.dispose()
    expect(listeners.size).toBe(1)
    expect(runtime.onMessage.removeListener).not.toHaveBeenCalled()
    expect(() => first.handle('double', handler)).toThrow('disposed')
    await expect(first.send('double', 4)).rejects.toThrow('disposed')
    expect(await second.send('double', 4)).toBe(8)
    const recreated = messaging.channel<Schema>('first')
    expect(recreated).not.toBe(first)
    expect(messaging.channel<Schema>('first')).toBe(recreated)
    const stopRecreated = recreated.handle('double', handler)
    staleStop()
    staleStop()
    first.dispose()
    expect(messaging.channel<Schema>('first')).toBe(recreated)
    expect(await recreated.send('double', 5)).toBe(10)
    expect(listeners.size).toBe(1)
    stopSecond()
    stopSecond()
    expect(listeners.size).toBe(1)
    stopRecreated()
    expect(listeners.size).toBe(0)
    const finalStop = recreated.handle('double', handler)
    stopRecreated()
    expect(await recreated.send('double', 6)).toBe(12)
    finalStop()
    expect(listeners.size).toBe(0)
  } finally {
    messaging.dispose()
  }
})

test('failed native listener registration rolls back handlers and permits retry', async () => {
  const { api, runtime, listeners } = bus()
  const messaging = createMessaging(api)
  const channel = messaging.channel<Schema>('app')
  const failure = new Error('Listener registration failed')
  runtime.onMessage.addListener.mockImplementationOnce(() => {
    throw failure
  })
  const handler = mock((value: unknown) => value)
  try {
    expect(() => channel.handle('echo', handler)).toThrow(failure)
    expect(listeners.size).toBe(0)
    const stop = channel.handle('echo', handler)
    expect(listeners.size).toBe(1)
    expect(await channel.send('echo', 'retry')).toBe('retry')
    expect(handler).toHaveBeenCalledTimes(1)
    stop()
    expect(listeners.size).toBe(0)
  } finally {
    messaging.dispose()
  }
})

test('factory disposal is terminal for cached and send-only channels', async () => {
  const { api, runtime, listeners } = bus()
  const messaging = createMessaging(api)
  const active = messaging.channel<Schema>('app')
  const sendOnly = messaging.channel<Schema>('send-only')
  const stop = active.handle('echo', (value) => value)
  const listener = [...listeners][0]!
  messaging.dispose()
  messaging.dispose()
  stop()
  expect(listeners.size).toBe(0)
  expect(runtime.onMessage.removeListener).toHaveBeenCalledTimes(1)
  expect(() => messaging.channel('app')).toThrow('Messaging is disposed')
  for (const channel of [active, sendOnly]) {
    expect(() => channel.handle('echo', (value) => value)).toThrow('disposed')
    await expect(channel.send('echo', 'value')).rejects.toThrow('disposed')
  }
  const respond = mock(() => {})
  expect(listener(request, { id: 'test' }, respond)).toBe(false)
  expect(respond).not.toHaveBeenCalled()
  expect(runtime.sendMessage).not.toHaveBeenCalled()
})

test('unregistered, malformed and external messages return false without capturing a response', async () => {
  const { api, runtime, listeners } = bus()
  const messaging = createMessaging(api)
  const channel = messaging.channel<Schema>('app')
  const handler = mock((value: unknown) => value)
  channel.handle('echo', handler)
  const listener = [...listeners][0]!
  const respond = mock(() => {})
  try {
    for (const message of [
      null,
      undefined,
      1,
      'unrelated',
      [],
      {},
      { kind: 'unrelated' },
      { ...request, __webext_rpc__: 2 },
      { ...request, channel: 'unregistered' },
      { ...request, channel: 1 },
      { ...request, type: 'unregistered' },
      { ...request, type: 1 },
      { ...request, empty: undefined },
      { ...request, empty: 'true' },
    ]) {
      expect(listener(message, { id: 'test' }, respond)).toBe(false)
    }
    for (const sender of [{ id: 'external' }, {}]) {
      expect(listener(request, sender, respond)).toBe(false)
    }
    expect(listener(request, { id: 'test' })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
    const nativeListener: Listener = (message, _sender, sendResponse) => {
      if ((message as { kind?: string })?.kind !== 'unrelated') return false
      sendResponse?.('native response')
      return true
    }
    runtime.onMessage.addListener(nativeListener)
    try {
      expect(await runtime.sendMessage({ kind: 'unrelated' })).toBe(
        'native response'
      )
      expect(handler).not.toHaveBeenCalled()
      messaging.dispose()
      expect(listeners.size).toBe(1)
      expect(listeners.has(nativeListener)).toBe(true)
    } finally {
      runtime.onMessage.removeListener(nativeListener)
    }
  } finally {
    messaging.dispose()
  }
})

test('stopping and disposing do not cancel an already invoked handler', async () => {
  const { api, listeners } = bus()
  const messaging = createMessaging(api)
  const channel = messaging.channel<Schema>('app')
  let finish!: (value: unknown) => void
  const handler = mock(
    () =>
      new Promise<unknown>((resolve) => {
        finish = resolve
      })
  )
  const stop = channel.handle('echo', handler)
  const pending = channel.send('echo', 'value', { timeoutMs: 100 })
  expect(handler).toHaveBeenCalledTimes(1)
  stop()
  channel.dispose()
  messaging.dispose()
  expect(listeners.size).toBe(0)
  finish('completed')
  expect(await pending).toBe('completed')
})

test.each([
  'success',
  'remote error',
  'incompatible response',
  'native rejection',
  'native throw',
  'timeout',
  'abort',
] as const)(
  'a %s cleans up its timer and AbortSignal listener',
  async (outcome) => {
    const { api, runtime } = bus()
    const nativeError = new Error('Native failure')
    runtime.sendMessage = mock((_message: unknown): Promise<unknown> => {
      switch (outcome) {
        case 'success':
          return Promise.resolve(response)
        case 'remote error':
          return Promise.resolve({
            __webext_rpc__: 1,
            ok: false,
            error: { name: 'TypeError', message: 'Remote failure' },
          })
        case 'incompatible response':
          return Promise.resolve({ ok: true })
        case 'native rejection':
          return Promise.reject(nativeError)
        case 'native throw':
          throw nativeError
        default:
          return new Promise(() => {})
      }
    })
    const messaging = createMessaging(api)
    const channel = messaging.channel<Schema>('app')
    const controller = new AbortController()
    const add = spyOn(controller.signal, 'addEventListener')
    const remove = spyOn(controller.signal, 'removeEventListener')
    const setTimer = spyOn(globalThis, 'setTimeout')
    const clearTimer = spyOn(globalThis, 'clearTimeout')
    try {
      const pending = channel.send('echo', 'value', {
        timeoutMs: outcome === 'timeout' ? 5 : 100,
        signal: controller.signal,
      })
      if (outcome === 'abort') controller.abort(new Error('Cancelled'))
      switch (outcome) {
        case 'success':
          expect(await pending).toBe('value')
          break
        case 'remote error':
          await expect(pending).rejects.toBeInstanceOf(RemoteError)
          break
        case 'incompatible response':
          await expect(pending).rejects.toThrow('No compatible response')
          break
        case 'native rejection':
        case 'native throw':
          await expect(pending).rejects.toBe(nativeError)
          break
        case 'timeout':
          await expect(pending).rejects.toBeInstanceOf(MessageTimeoutError)
          break
        case 'abort':
          await expect(pending).rejects.toBe(controller.signal.reason)
          break
      }
      if (outcome === 'native throw') {
        expect(add).not.toHaveBeenCalled()
        expect(setTimer).not.toHaveBeenCalled()
        expect(remove).not.toHaveBeenCalled()
        expect(clearTimer).not.toHaveBeenCalled()
      } else {
        expect(setTimer).toHaveBeenCalledTimes(1)
        expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[0]?.value)
        expect(add).toHaveBeenCalledTimes(1)
        expect(add.mock.calls[0]?.[0]).toBe('abort')
        expect(remove).toHaveBeenCalledTimes(1)
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
      }
    } finally {
      add.mockRestore()
      remove.mockRestore()
      setTimer.mockRestore()
      clearTimer.mockRestore()
      messaging.dispose()
    }
  }
)

test.each(['success', 'abort', 'timeout'] as const)(
  'a %s uses and cleans up the original signal even if send options change',
  async (outcome) => {
    const { api, runtime } = bus()
    let finish!: (value: unknown) => void
    runtime.sendMessage = mock(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve
        })
    )
    const messaging = createMessaging(api)
    const channel = messaging.channel<Schema>('app')
    const original = new AbortController()
    const replacement = new AbortController()
    const options: SendOptions = {
      timeoutMs: outcome === 'timeout' ? 5 : 100,
      signal: original.signal,
    }
    const add = spyOn(original.signal, 'addEventListener')
    const removeOriginal = spyOn(original.signal, 'removeEventListener')
    const removeReplacement = spyOn(replacement.signal, 'removeEventListener')
    try {
      const pending = channel.send('echo', 'value', options)
      options.signal = replacement.signal
      if (outcome === 'success') {
        finish(response)
        expect(await pending).toBe('value')
      } else if (outcome === 'abort') {
        const reason = new Error('Original signal cancelled')
        original.abort(reason)
        await expect(pending).rejects.toBe(reason)
      } else {
        await expect(pending).rejects.toBeInstanceOf(MessageTimeoutError)
      }
      expect(removeOriginal).toHaveBeenCalledWith(
        'abort',
        add.mock.calls[0]?.[1]
      )
      expect(removeReplacement).not.toHaveBeenCalled()
    } finally {
      const listener = add.mock.calls[0]?.[1]
      if (listener) original.signal.removeEventListener('abort', listener)
      add.mockRestore()
      removeOriginal.mockRestore()
      removeReplacement.mockRestore()
      messaging.dispose()
    }
  }
)

test('pre-abort and abort during the native call reject without leaking listeners', async () => {
  const { api, runtime } = bus()
  const messaging = createMessaging(api)
  const channel = messaging.channel<Schema>('app')
  const controller = new AbortController()
  const add = spyOn(controller.signal, 'addEventListener')
  const remove = spyOn(controller.signal, 'removeEventListener')
  const early = new AbortController()
  early.abort(new Error('Already cancelled'))
  try {
    await expect(
      channel.send('echo', 'value', { signal: early.signal })
    ).rejects.toBe(early.signal.reason)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    runtime.sendMessage = mock(() => {
      controller.abort()
      return new Promise<unknown>(() => {})
    })
    await expect(
      channel.send('echo', 'value', {
        timeoutMs: 100,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
  } finally {
    add.mockRestore()
    remove.mockRestore()
    messaging.dispose()
  }
})

test('concurrent waits have independent abort and timeout cleanup', async () => {
  const { api, runtime } = bus()
  runtime.sendMessage = mock(() => new Promise<unknown>(() => {}))
  const messaging = createMessaging(api)
  const channel = messaging.channel<Schema>('app')
  const first = new AbortController()
  const second = new AbortController()
  const removeFirst = spyOn(first.signal, 'removeEventListener')
  const removeSecond = spyOn(second.signal, 'removeEventListener')
  try {
    const aborted = channel.send('echo', 'first', {
      timeoutMs: 100,
      signal: first.signal,
    })
    const timedOut = channel.send('echo', 'second', {
      timeoutMs: 15,
      signal: second.signal,
    })
    first.abort(new Error('Only first'))
    expect(removeSecond).not.toHaveBeenCalled()
    await expect(aborted).rejects.toBe(first.signal.reason)
    expect(removeFirst).toHaveBeenCalledTimes(1)
    await expect(timedOut).rejects.toBeInstanceOf(MessageTimeoutError)
    expect(removeSecond).toHaveBeenCalledTimes(1)
    expect(second.signal.aborted).toBe(false)
  } finally {
    removeFirst.mockRestore()
    removeSecond.mockRestore()
    messaging.dispose()
  }
})

test('the default wait remains ten seconds and send methods keep native receivers and targets', async () => {
  const { api, runtime } = bus()
  runtime.sendMessage = mock(function (this: unknown, _message: unknown) {
    expect(this).toBe(runtime)
    return Promise.resolve(response)
  })
  const tabs = {
    sendMessage: mock(function (
      this: unknown,
      _tabId: number,
      _message: unknown,
      _target: unknown
    ) {
      expect(this).toBe(tabs)
      return Promise.resolve(response)
    }),
  }
  api.tabs = tabs as unknown as MessagingApi['tabs']
  const messaging = createMessaging(api)
  const channel = messaging.channel<Schema>('app')
  const setTimer = spyOn(globalThis, 'setTimeout')
  try {
    expect(await channel.send('echo', 'value')).toBe('value')
    expect(setTimer.mock.calls[0]?.[1]).toBe(10_000)
    expect(await channel.send('echo', 'value', { tabId: 12 })).toBe('value')
    expect(tabs.sendMessage).toHaveBeenLastCalledWith(12, request, {})
    expect(
      await channel.send('echo', 'value', {
        tabId: 12,
        frameId: 3,
        documentId: 'document',
      })
    ).toBe('value')
    expect(tabs.sendMessage).toHaveBeenLastCalledWith(12, request, {
      frameId: 3,
      documentId: 'document',
    })
    await expect(channel.send('echo', 'value', { frameId: 3 })).rejects.toThrow(
      'requires tabId'
    )
    await expect(
      channel.send('echo', 'value', { documentId: 'document' })
    ).rejects.toThrow('requires tabId')
    await expect(channel.send('echo', 'value', { tabId: -1 })).rejects.toThrow(
      'Invalid tab ID'
    )
    expect(tabs.sendMessage).toHaveBeenCalledTimes(2)
    api.tabs = undefined
    await expect(channel.send('echo', 'value', { tabId: 12 })).rejects.toThrow(
      'messaging.send to tab'
    )
  } finally {
    setTimer.mockRestore()
    messaging.dispose()
  }
})

test('encoding top-level JSON primitives preserves their values and normalizes negative zero', () => {
  for (const value of [undefined, null, true, false, '', 'value', 0, -0, 1.5]) {
    const result = encode(value)
    expect(result).toBe(value === undefined ? null : value === 0 ? 0 : value)
    expect(Object.is(result, -0)).toBe(false)
  }
})

test('JSON roundtrips normalize negative zero and separate shared snapshots after reading once', () => {
  let reads = 0
  const shared = {
    get value() {
      reads++
      return -0
    },
  }
  const input = { left: shared, right: shared, array: [shared, shared] }
  const result = encode(input) as typeof input
  expect(reads).toBe(1)
  expect(result).toEqual({
    left: { value: 0 },
    right: { value: 0 },
    array: [{ value: 0 }, { value: 0 }],
  })
  expect(Object.is(result.left.value, -0)).toBe(false)
  expect(Object.is(encode(-0), 0)).toBe(true)
  expect(result.left).not.toBe(result.right)
  expect(result.left).not.toBe(result.array[0])
  expect(result.array[0]).not.toBe(result.array[1])
  expect(result.left).not.toBe(shared)
})

test.each(['request', 'response'] as const)(
  'unsupported primitive and non-finite %s values remain rejected',
  async (direction) => {
    const { api, runtime } = bus()
    const messaging = createMessaging(api)
    const channel = messaging.channel<Schema>('app')
    let value: unknown
    channel.handle('echo', (request) =>
      direction === 'request' ? request : value
    )
    try {
      for (const unsupported of [
        1n,
        Symbol('value'),
        () => {},
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        value = unsupported
        const count = runtime.sendMessage.mock.calls.length
        await expect(
          channel.send('echo', direction === 'request' ? unsupported : null)
        ).rejects.toBeInstanceOf(
          direction === 'request' ? TypeError : RemoteError
        )
        expect(runtime.sendMessage.mock.calls.length).toBe(
          count + (direction === 'request' ? 0 : 1)
        )
      }
    } finally {
      messaging.dispose()
    }
  }
)
