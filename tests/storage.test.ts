import { expect, mock, test } from 'bun:test'

import { createStorage } from '../src/storage'

function storageApi() {
  type Change = { oldValue?: unknown; newValue?: unknown }
  type Listener = (changes: Record<string, Change>, areaName: string) => void
  const listeners = new Set<Listener>()
  const values: Record<string, unknown> = {
    greeting: '日本語',
    empty: null,
    count: 0,
    flag: false,
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
    for (const [key, value] of Object.entries(items))
      Object.defineProperty(values, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
  })
  const remove = mock(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
  })
  const area = { get, set, remove }
  const removeListener = mock((listener: Listener) => {
    listeners.delete(listener)
  })
  const api = {
    local: area,
    sync: area,
    onChanged: {
      addListener: (listener: Listener) => {
        listeners.add(listener)
      },
      removeListener,
    },
  }
  const storage = createStorage(
    api as unknown as Parameters<typeof createStorage>[0]
  )
  function emit(changes: Record<string, Change>, areaName: string) {
    for (const listener of [...listeners]) listener(changes, areaName)
  }
  return { storage, listeners, emit, get, set, remove, values, removeListener }
}

test('storage helpers retain falsy values, defaults and UTF-8 byte estimates', async () => {
  const { storage, get, set, values } = storageApi()
  expect(await storage.local.getValue('empty', 'default')).toBeNull()
  expect(await storage.local.getValue('count', 42)).toBe(0)
  expect(await storage.local.getValue('flag', true)).toBe(false)
  expect(await storage.local.getValue('missing')).toBeUndefined()
  expect(await storage.local.getValue('missing', 'default')).toBe('default')
  expect(await storage.local.getKeys()).toEqual(Object.keys(values))
  expect(await storage.local.getBytesInUse('greeting')).toBe(19)
  expect(get).toHaveBeenLastCalledWith('greeting')
  expect(await storage.local.getBytesInUse(['count', 'flag'])).toBe(15)
  expect(get).toHaveBeenLastCalledWith(['count', 'flag'])
  expect(storage.session).toBeUndefined()
  expect(await storage.local.getValue('__proto__', 'default')).toBe('default')
  await storage.local.setValue('__proto__', 'data')
  expect(set.mock.calls[0]?.[0]).toEqual({ ['__proto__']: 'data' })
})

test('namespaces qualify keys and isolate reads, defaults, byte estimates and deletion', async () => {
  const { storage, values, set, get } = storageApi()
  const settings = storage.local.namespace('settings')
  const other = storage.local.namespace('other')
  for (const name of ['', 'settings:child'])
    expect(() => storage.local.namespace(name)).toThrow(TypeError)
  await settings.setValue('theme', 'dark')
  expect(set).toHaveBeenLastCalledWith({ 'settings:theme': 'dark' })
  await settings.set({
    count: 0,
    empty: null,
    flag: false,
    '': 'empty key',
    'a:b': 'colon',
  })
  await other.setValue('theme', 'light')
  await settings.setValue('__proto__', 'safe')
  expect(await settings.getValue<string>('theme')).toBe('dark')
  expect(await other.getValue<string>('theme')).toBe('light')
  expect(await settings.getValue('missing', 'default')).toBe('default')
  expect(
    await settings.get({
      empty: 'fallback',
      missing: 'default',
      count: 42,
      flag: true,
    })
  ).toEqual({
    empty: null,
    missing: 'default',
    count: 0,
    flag: false,
  })
  expect(get).toHaveBeenLastCalledWith({
    'settings:empty': 'fallback',
    'settings:missing': 'default',
    'settings:count': 42,
    'settings:flag': true,
  })
  expect(await settings.get(['theme', 'missing'])).toEqual({ theme: 'dark' })
  expect(await settings.get('theme')).toEqual({ theme: 'dark' })
  expect(await settings.getValue<string>('')).toBe('empty key')
  expect(await settings.getValue<string>('a:b')).toBe('colon')
  expect(await settings.get()).toEqual({
    theme: 'dark',
    count: 0,
    empty: null,
    flag: false,
    '': 'empty key',
    'a:b': 'colon',
    ['__proto__']: 'safe',
  })
  expect(await settings.getKeys()).toEqual([
    'theme',
    'count',
    'empty',
    'flag',
    '',
    'a:b',
    '__proto__',
  ])
  expect(await settings.getBytesInUse('theme')).toBe(20)
  expect(await settings.getBytesInUse()).toBe(
    await storage.local.getBytesInUse(
      Object.keys(values).filter((key) => key.startsWith('settings:'))
    )
  )
  expect(await settings.getBytesInUse([])).toBe(0)
  await settings.remove(['theme', 'a:b'])
  expect(await settings.getValue('theme')).toBeUndefined()
  await settings.clear()
  expect(await settings.get(null)).toEqual({})
  expect(await settings.getBytesInUse(null)).toBe(0)
  expect(await other.get()).toEqual({ theme: 'light' })
  expect(await storage.local.getValue<string>('greeting')).toBe('日本語')
})

test('namespace fallback byte counts read the area only once', async () => {
  const { storage, get } = storageApi()
  const settings = storage.local.namespace('settings')
  await settings.set({ theme: 'dark', count: 0 })
  get.mockClear()
  expect(await settings.getBytesInUse()).toBe(35)
  expect(get).toHaveBeenCalledTimes(1)
  expect(get).toHaveBeenLastCalledWith(null)
  get.mockClear()
  expect(await settings.getBytesInUse(null)).toBe(35)
  expect(get).toHaveBeenCalledTimes(1)
})

test('namespaces preserve native byte counts, method receivers and read-only errors', async () => {
  const getKeys = mock(async function (this: unknown) {
    expect(this).toBe(native)
    return ['settings:theme', 'other:theme']
  })
  const getBytesInUse = mock(async function (
    this: unknown,
    _keys?: string | string[] | null
  ) {
    expect(this).toBe(native)
    return 123
  })
  const error = new Error('read-only')
  const remove = mock(async (_keys: string | string[]) => {
    throw error
  })
  const native = { getKeys, getBytesInUse, remove }
  const storage = createStorage({
    local: native,
    managed: native,
  } as unknown as Parameters<typeof createStorage>[0])
  const settings = storage.local.namespace('settings')
  expect(settings.capabilities).toBe(storage.local.capabilities)
  expect(Object.isFrozen(settings.capabilities)).toBe(true)
  expect(settings.capabilities).toEqual({
    getKeys: 'native',
    getBytesInUse: 'native',
  })
  expect(await settings.getKeys()).toEqual(['theme'])
  expect(await settings.getBytesInUse()).toBe(123)
  expect(getBytesInUse).toHaveBeenLastCalledWith(['settings:theme'])
  expect(await settings.getBytesInUse([])).toBe(123)
  expect(getBytesInUse).toHaveBeenLastCalledWith([])
  await expect(storage.managed.namespace('empty').clear()).rejects.toBe(error)
  expect(remove).toHaveBeenCalledWith([])
})

test('namespace watches share disposal and reject other namespaces or areas', () => {
  const { storage, emit, listeners } = storageApi()
  const listener = mock(
    (_value: string | undefined, _previous: string | undefined) => {}
  )
  const stop = storage.local.namespace('settings').watch('theme', listener)
  emit({ 'other:theme': { newValue: 'light' } }, 'local')
  emit({ 'settings:theme': { newValue: 'light' } }, 'sync')
  expect(listener).not.toHaveBeenCalled()
  emit({ 'settings:theme': { newValue: 'dark', oldValue: 'light' } }, 'local')
  expect(listener).toHaveBeenLastCalledWith('dark', 'light')
  emit({ 'settings:theme': { oldValue: 'dark' } }, 'local')
  expect(listener).toHaveBeenLastCalledWith(undefined, 'dark')
  storage.dispose()
  stop()
  expect(listeners.size).toBe(0)
})

test('storage watches filter by area and key, report removals and stop exactly once', () => {
  const { storage, listeners, emit, removeListener } = storageApi()
  const local = mock(
    (_value: string | undefined, _previous: string | undefined) => {}
  )
  const sync = mock(
    (_value: string | undefined, _previous: string | undefined) => {}
  )
  const stopLocal = storage.local.watch('theme', local)
  const stopSync = storage.sync.watch('theme', sync)
  emit({ ignored: { newValue: 'dark' } }, 'local')
  emit({ theme: { oldValue: 'light', newValue: 'dark' } }, 'managed')
  expect(local).not.toHaveBeenCalled()
  expect(sync).not.toHaveBeenCalled()
  emit({ theme: { oldValue: 'light', newValue: 'dark' } }, 'local')
  expect(local).toHaveBeenLastCalledWith('dark', 'light')
  expect(sync).not.toHaveBeenCalled()
  emit({ theme: { oldValue: 'dark' } }, 'sync')
  expect(sync).toHaveBeenLastCalledWith(undefined, 'dark')
  stopLocal()
  stopLocal()
  expect(removeListener).toHaveBeenCalledTimes(1)
  expect(listeners.size).toBe(1)
  storage.dispose()
  stopSync()
  storage.dispose()
  expect(removeListener).toHaveBeenCalledTimes(2)
  expect(listeners.size).toBe(0)
  emit({ theme: { newValue: 'later' } }, 'sync')
  expect(sync).toHaveBeenCalledTimes(1)
  storage.local.watch('theme', local)
  expect(listeners.size).toBe(1)
  storage.dispose()
  expect(listeners.size).toBe(0)
})
