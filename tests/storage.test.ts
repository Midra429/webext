import { expect, mock, test } from 'bun:test'

import { createStorage } from '../src/storage'

function storageApi() {
  type Change = { oldValue?: unknown; newValue?: unknown }
  type Listener = (changes: Record<string, Change>, areaName: string) => void
  const listeners = new Set<Listener>()
  const values = { greeting: '日本語', empty: null, count: 0, flag: false }
  const get = mock(async (keys?: string | string[] | null) => {
    if (keys == null) return values
    return Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys])
        .filter((key) => Object.hasOwn(values, key))
        .map((key) => [key, values[key as keyof typeof values]])
    )
  })
  const set = mock(async (_items: unknown) => {})
  const area = { get, set }
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
  return { storage, listeners, emit, get, set, values, removeListener }
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
  await storage.local.setValue('__proto__', 'data')
  expect(set.mock.calls[0]?.[0]).toEqual({ ['__proto__']: 'data' })
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
