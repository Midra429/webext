import { expect, mock, test } from 'bun:test'

import {
  MessageTimeoutError,
  RemoteError,
  createMainWorldStorage,
} from '../src'
import { createStorage } from '../src/storage'

function setup() {
  const domListeners = new Set<(event: MessageEvent) => void>()
  const window = {
    location: { origin: 'https://example.com', href: 'https://example.com/' },
    addEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void
    ) => {
      domListeners.add(listener)
    },
    removeEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void
    ) => {
      domListeners.delete(listener)
    },
    postMessage(data: unknown, origin: string) {
      const snapshot = structuredClone(data)
      queueMicrotask(() => {
        for (const listener of [...domListeners])
          listener({
            data: snapshot,
            source: window,
            origin,
          } as unknown as MessageEvent)
      })
    },
  }
  type Change = { oldValue?: unknown; newValue?: unknown }
  type Listener = (changes: Record<string, Change>, area: string) => void
  const changes = new Set<Listener>()
  const values: Record<string, unknown> = {
    private: 'secret',
    'other:theme': 'private',
  }
  const emit = (entries: Record<string, Change>, area = 'local') => {
    for (const listener of [...changes]) listener(entries, area)
  }
  const get = mock(
    async (keys?: string | string[] | Record<string, unknown> | null) => {
      if (keys == null) return { ...values }
      if (typeof keys === 'object' && !Array.isArray(keys))
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.hasOwn(values, key) ? values[key] : fallback,
          ])
        )
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, values[key]])
      )
    }
  )
  const set = mock(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      const oldValue = values[key]
      Object.defineProperty(values, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      })
      emit({ [key]: { oldValue, newValue: value } })
    }
  })
  const remove = mock(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!Object.hasOwn(values, key)) continue
      const oldValue = values[key]
      delete values[key]
      emit({ [key]: { oldValue } })
    }
  })
  const native = {
    local: { get, set, remove },
    sync: { get, set, remove },
    managed: { get, set, remove },
    onChanged: {
      addListener: (listener: Listener) => {
        changes.add(listener)
      },
      removeListener: (listener: Listener) => {
        changes.delete(listener)
      },
    },
  }
  const storage = createStorage(
    native as unknown as Parameters<typeof createStorage>[0],
    'content-script'
  )
  const options = {
    namespace: 'test/world',
    window: window as unknown as Window,
    timeoutMs: 50,
  }
  const main = createMainWorldStorage(options)
  const start = () =>
    storage.bridgeMainWorld({
      ...options,
      scopes: [
        { area: 'local', namespace: 'page', writable: true },
        { area: 'sync', namespace: 'readonly' },
        { area: 'managed', namespace: 'policy', writable: true },
      ],
    })
  return {
    storage,
    main,
    options,
    start,
    values,
    get,
    set,
    remove,
    emit,
    domListeners,
    changes,
    dispose() {
      main.dispose()
      storage.dispose()
    },
  }
}

test('MAIN storage handles scoped CRUD, defaults and byte counts without revealing other keys', async () => {
  const env = setup()
  env.start()
  const area = env.main.local.namespace('page')
  try {
    await area.setValue('theme', 'dark')
    expect(env.set).toHaveBeenLastCalledWith({ 'page:theme': 'dark' })
    await area.set({
      count: 0,
      empty: null,
      ['__proto__']: 'safe',
      'a:b': 'colon',
    })
    expect(await area.getValue<string>('theme')).toBe('dark')
    expect(await area.getValue('missing', false)).toBe(false)
    expect(
      await area.get({ count: 42, empty: 'fallback', missing: false })
    ).toEqual({ count: 0, empty: null, missing: false })
    expect(await area.get()).toEqual({
      theme: 'dark',
      count: 0,
      empty: null,
      ['__proto__']: 'safe',
      'a:b': 'colon',
    })
    expect(await area.getKeys()).toEqual([
      'theme',
      'count',
      'empty',
      '__proto__',
      'a:b',
    ])
    expect(await area.getBytesInUse('theme')).toBe(16)
    expect(await area.getCapabilities()).toEqual({
      getKeys: 'polyfilled',
      getBytesInUse: 'estimated',
    })
    await area.remove(['theme', 'a:b'])
    expect(await area.getValue('theme')).toBeUndefined()
    await area.clear()
    expect(await area.get(null)).toEqual({})
    expect(await area.getBytesInUse([])).toBe(0)
    expect(env.values).toEqual({ private: 'secret', 'other:theme': 'private' })
  } finally {
    env.dispose()
  }
  expect(env.domListeners.size).toBe(0)
  expect(env.changes.size).toBe(0)
})

test('MAIN storage enforces allowlists, read-only grants, JSON constraints and input validation', async () => {
  const env = setup()
  env.start()
  const area = env.main.local.namespace('page')
  try {
    await expect(env.main.local.namespace('other').get()).rejects.toThrow(
      'not allowed'
    )
    await expect(
      env.main.session.namespace('page').getCapabilities()
    ).rejects.toThrow('not allowed')
    for (const readonly of [
      env.main.sync.namespace('readonly'),
      env.main.managed.namespace('policy'),
    ]) {
      await expect(readonly.setValue('key', 'value')).rejects.toThrow(
        'read-only'
      )
      await expect(readonly.remove('key')).rejects.toThrow('read-only')
      await expect(readonly.clear()).rejects.toThrow('read-only')
    }
    expect(env.set).not.toHaveBeenCalled()
    expect(env.remove).not.toHaveBeenCalled()
    for (const name of ['', 'page:child'])
      expect(() => env.main.local.namespace(name)).toThrow(TypeError)
    await expect(area.setValue('key', new Date())).rejects.toBeInstanceOf(
      TypeError
    )
    await expect(area.setValue('key', undefined)).rejects.toBeInstanceOf(
      TypeError
    )
    await expect(area.get(true as unknown as string)).rejects.toMatchObject({
      remoteName: 'TypeError',
    })
    await expect(
      area.remove([1] as unknown as string[])
    ).rejects.toBeInstanceOf(RemoteError)
    expect(env.get).not.toHaveBeenCalled()
    expect(() => env.start()).toThrow('already registered')
  } finally {
    env.dispose()
  }
})

test('MAIN storage changes are scoped, stoppable and cleanly disposed alongside pending requests', async () => {
  const env = setup()
  const stopBridge = env.start()
  const area = env.main.local.namespace('page')
  const receive = mock((_value: unknown, _old: unknown) => {})
  const stopWatch = area.watch('theme', receive)
  try {
    env.emit({ 'other:theme': { newValue: 'private' } })
    env.emit({ 'page:theme': { newValue: 'other area' } }, 'sync')
    await area.setValue('theme', 'dark')
    expect(receive).toHaveBeenLastCalledWith('dark', undefined)
    expect(receive).toHaveBeenCalledTimes(1)
    await area.remove('theme')
    expect(receive).toHaveBeenLastCalledWith(undefined, 'dark')
    stopWatch()
    stopWatch()
    await area.setValue('theme', 'light')
    expect(receive).toHaveBeenCalledTimes(2)
    stopBridge()
    stopBridge()
    expect(env.changes.size).toBe(0)
    env.start()
    stopBridge()
    expect(await area.getValue<string>('theme')).toBe('light')
    env.storage.dispose()
    expect(env.changes.size).toBe(0)
    await expect(area.get()).rejects.toBeInstanceOf(MessageTimeoutError)
    const pending = area.get()
    env.main.dispose()
    await expect(pending).rejects.toThrow('disposed')
    await expect(area.get()).rejects.toThrow('disposed')
    expect(() => area.watch('key', receive)).toThrow('disposed')
  } finally {
    env.dispose()
  }
  expect(env.domListeners.size).toBe(0)
})
