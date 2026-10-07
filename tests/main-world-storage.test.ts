import type { MainWorldStorageBridgeOptions } from '../src/storage/main-world'

import { expect, mock, test } from 'bun:test'

import { MessageTimeoutError, RemoteError } from '../src/errors'
import { createStorage } from '../src/storage'
import { createMainWorldStorage } from '../src/storage/main-world'

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
  const dispatch = (
    data: unknown,
    origin = window.location.origin,
    source: unknown = window
  ) => {
    for (const listener of [...domListeners])
      listener({ data, source, origin } as MessageEvent)
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
  const start = (
    scopes: MainWorldStorageBridgeOptions['scopes'] = [
      { area: 'local', namespace: 'page', writable: true },
      { area: 'sync', namespace: 'readonly' },
      { area: 'managed', namespace: 'policy', writable: true },
    ]
  ) => storage.bridgeMainWorld({ ...options, scopes })
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
    native,
    dispatch,
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

test('MAIN storage rejects foreign window messages and malformed requests or changes', async () => {
  const env = setup()
  env.start()
  const receive = mock((_value: unknown, _old: unknown) => {})
  env.main.local.namespace('page').watch('theme', receive)
  const request = {
    __webext_window_rpc__: 1,
    namespace: `${env.options.namespace}/storage`,
    from: 'main',
    id: 'forged',
    kind: 'request',
    target: 'content-script',
    message: {
      __webext_rpc__: 1,
      channel: '@midra/webext/storage',
      type: 'request',
      empty: false,
      payload: {
        area: 'local',
        namespace: 'page',
        operation: 'set',
        argument: { theme: 'dark' },
      },
    },
  }
  const notification = {
    ...request,
    from: 'content',
    kind: 'notification',
    sender: {},
    message: {
      ...request.message,
      type: 'changed',
      payload: {
        area: 'local',
        namespace: 'page',
        changes: { theme: { newValue: 'dark' } },
      },
    },
  }
  try {
    for (const message of [request, notification]) {
      env.dispatch(message, 'https://attacker.example')
      env.dispatch(message, env.options.window.location.origin, {})
    }
    for (const argument of [null, ['theme'], new Date()])
      env.dispatch({
        ...request,
        message: {
          ...request.message,
          payload: { ...request.message.payload, argument },
        },
      })
    for (const changes of [null, [], { theme: null }, { theme: [] }])
      env.dispatch({
        ...notification,
        message: {
          ...notification.message,
          payload: { ...notification.message.payload, changes },
        },
      })
    await Promise.resolve()
    expect(env.set).not.toHaveBeenCalled()
    expect(receive).not.toHaveBeenCalled()
    // 同じページからの偽装は防げないが、未公開の名前空間へは到達できない。
    env.dispatch({
      ...request,
      message: {
        ...request.message,
        payload: { ...request.message.payload, namespace: 'other' },
      },
    })
    expect(env.set).not.toHaveBeenCalled()
    env.dispatch(request)
    await Promise.resolve()
    expect(env.set).toHaveBeenCalledWith({ 'page:theme': 'dark' })
    expect(receive).toHaveBeenCalledWith('dark', undefined)
  } finally {
    env.dispose()
  }
})

test('MAIN storage rolls back a failed native listener registration', () => {
  const env = setup()
  const addListener = env.native.onChanged.addListener
  const error = new Error('registration failed')
  env.native.onChanged.addListener = () => {
    throw error
  }
  try {
    expect(() => env.start()).toThrow(error)
    expect(env.changes.size).toBe(0)
    expect(env.domListeners.size).toBe(1)
    env.native.onChanged.addListener = addListener
    expect(() => env.start()).not.toThrow()
    expect(env.changes.size).toBe(1)
    expect(env.domListeners.size).toBe(2)
  } finally {
    env.dispose()
  }
  expect(env.domListeners.size).toBe(0)
})

test('MAIN storage listener and error reporter failures do not stop other watchers', async () => {
  const env = setup()
  const error = new Error('watch failed')
  const onError = mock(() => {
    throw new Error('report failed')
  })
  const main = createMainWorldStorage({ ...env.options, onError })
  env.start()
  const area = main.local.namespace('page')
  const receive = mock((_value: unknown, _old: unknown) => {})
  area.watch('theme', () => {
    throw error
  })
  area.watch('theme', receive)
  try {
    await area.setValue('theme', 'dark')
    expect(onError).toHaveBeenCalledWith(error)
    expect(receive).toHaveBeenCalledWith('dark', undefined)
  } finally {
    main.dispose()
    env.dispose()
  }
})

test('MAIN storage change forwarding reads each native change once across grants', async () => {
  const env = setup()
  env.start([
    { area: 'local', namespace: 'page' },
    { area: 'local', namespace: 'other' },
    { area: 'sync', namespace: 'page' },
  ])
  const page = mock((_value: unknown, _old: unknown) => {})
  const other = mock((_value: unknown, _old: unknown) => {})
  const sync = mock((_value: unknown, _old: unknown) => {})
  env.main.local.namespace('page').watch('theme:variant', page)
  env.main.local.namespace('other').watch('__proto__', other)
  env.main.sync.namespace('page').watch('theme:variant', sync)
  const pageChange = mock(() => ({ newValue: 'dark' }))
  const otherChange = mock(() => ({ newValue: false }))
  const privateChange = mock(() => ({ newValue: 'secret' }))
  try {
    env.emit(
      Object.defineProperties(
        {},
        {
          'page:theme:variant': { enumerable: true, get: pageChange },
          'other:__proto__': { enumerable: true, get: otherChange },
          private: { enumerable: true, get: privateChange },
        }
      )
    )
    await Promise.resolve()
    expect(pageChange).toHaveBeenCalledTimes(1)
    expect(otherChange).toHaveBeenCalledTimes(1)
    expect(privateChange).not.toHaveBeenCalled()
    expect(page).toHaveBeenCalledWith('dark', undefined)
    expect(other).toHaveBeenCalledWith(false, undefined)
    expect(sync).not.toHaveBeenCalled()
  } finally {
    env.dispose()
  }
})

test('MAIN storage stops forwarding immediately when onError disposes the bridge', async () => {
  const env = setup()
  let stop = () => {}
  const onError = mock(() => stop())
  stop = env.storage.bridgeMainWorld({
    ...env.options,
    scopes: [
      { area: 'local', namespace: 'page' },
      { area: 'local', namespace: 'other' },
    ],
    onError,
  })
  const receive = mock((_value: unknown, _old: unknown) => {})
  env.main.local.namespace('other').watch('theme', receive)
  try {
    env.emit({
      'page:theme': { newValue: new Date() },
      'other:theme': { newValue: 'dark' },
    })
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(receive).not.toHaveBeenCalled()
    expect(env.changes.size).toBe(0)
    expect(env.domListeners.size).toBe(1)
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
