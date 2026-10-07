import type {
  StorageMigration,
  StorageMigrationContext,
  StorageMigrationOptions,
} from '../src'

import { expect, mock, test } from 'bun:test'

import { UnsupportedOperationError } from '../src'
import { createStorage } from '../src/storage'

const VERSION_KEY = '_webext_storage_version'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function storageApi(initial: Record<string, unknown> = {}, nativeKeys = true) {
  const values = new Map(Object.entries(structuredClone(initial)))
  let readError: Error | undefined
  let writeError: { key: string; value: unknown; error: Error } | undefined
  const get = mock(async function (
    this: unknown,
    keys?: string | string[] | Record<string, unknown> | null
  ): Promise<Record<string, unknown>> {
    expect(this).toBe(native)
    if (readError) {
      const error = readError
      readError = undefined
      throw error
    }
    const result =
      keys == null
        ? Object.fromEntries(values)
        : typeof keys === 'object' && !Array.isArray(keys)
          ? Object.fromEntries(
              Object.entries(keys).map(([key, fallback]) => [
                key,
                values.has(key) ? values.get(key) : fallback,
              ])
            )
          : Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys])
                .filter((key) => values.has(key))
                .map((key) => [key, values.get(key)])
            )
    return structuredClone(result)
  })
  const set = mock(async function (
    this: unknown,
    items: Record<string, unknown>
  ): Promise<void> {
    expect(this).toBe(native)
    if (
      writeError &&
      Object.hasOwn(items, writeError.key) &&
      items[writeError.key] === writeError.value
    ) {
      const error = writeError.error
      writeError = undefined
      throw error
    }
    for (const [key, value] of Object.entries(structuredClone(items)))
      values.set(key, value)
  })
  const remove = mock(async function (
    this: unknown,
    keys: string | string[]
  ): Promise<void> {
    expect(this).toBe(native)
    for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
  })
  const clear = mock(async function (this: unknown): Promise<void> {
    expect(this).toBe(native)
    values.clear()
  })
  const getKeys = mock(async function (this: unknown): Promise<string[]> {
    expect(this).toBe(native)
    return [...values.keys()]
  })
  const native = {
    get,
    set,
    remove,
    clear,
    ...(nativeKeys ? { getKeys } : {}),
  }
  const wrap = () =>
    createStorage({
      local: native,
      managed: native,
    } as unknown as Parameters<typeof createStorage>[0])
  return {
    native,
    storage: wrap(),
    wrap,
    values,
    get,
    set,
    remove,
    clear,
    getKeys,
    failRead(error: Error) {
      readError = error
    },
    failWrite(key: string, value: unknown, error: Error) {
      writeError = { key, value, error }
    },
    expectNoIO() {
      for (const method of [get, set, remove, clear, getKeys])
        expect(method).not.toHaveBeenCalled()
    },
  }
}

function holdMigration() {
  const entered = deferred()
  const release = deferred()
  const migrate = mock(async () => {
    entered.resolve()
    await release.promise
  })
  return { entered, release, migrate }
}

test('migrations sort a frozen plan, checkpoint each step and clone CRUD values', async () => {
  const env = storageApi()
  const contexts: number[][] = []
  const plan: readonly StorageMigration[] = Object.freeze(
    [7, 1, 4].map((version) =>
      Object.freeze({
        version,
        async migrate({
          storage,
          fromVersion,
          toVersion,
        }: StorageMigrationContext) {
          contexts.push([fromVersion, toVersion])
          expect(await storage.getValue(VERSION_KEY, 0)).toBe(fromVersion)
          const value = { nested: { count: version } }
          await storage.setValue('data', value)
          value.nested.count = -1
          const read = await storage.getValue<typeof value>('data')
          expect(read).toEqual({ nested: { count: version } })
          if (read) read.nested.count = -2
          expect(await storage.get('data')).toEqual({
            data: { nested: { count: version } },
          })
        },
      })
    )
  )
  expect(await env.storage.local.migrate(plan)).toEqual({
    fromVersion: 0,
    toVersion: 7,
    appliedVersions: [1, 4, 7],
  })
  expect(plan.map((step) => step.version)).toEqual([7, 1, 4])
  expect(contexts).toEqual([
    [0, 1],
    [1, 4],
    [4, 7],
  ])
  expect(env.values.get('data')).toEqual({ nested: { count: 7 } })
  expect(
    env.set.mock.calls
      .map(([items]) => items)
      .filter(
        (items) => items !== undefined && Object.hasOwn(items, VERSION_KEY)
      )
  ).toEqual([{ [VERSION_KEY]: 1 }, { [VERSION_KEY]: 4 }, { [VERSION_KEY]: 7 }])
})

test('migrations skip saved steps and report only newly checkpointed versions', async () => {
  const env = storageApi({ [VERSION_KEY]: 2 })
  const skipped = mock(() => {})
  const applied = mock(
    ({ fromVersion, toVersion }: StorageMigrationContext) => {
      expect([fromVersion, toVersion]).toEqual([2, 5])
    }
  )
  const plan = [
    { version: 5, migrate: applied },
    { version: 1, migrate: skipped },
    { version: 2, migrate: skipped },
  ]
  expect(await env.storage.local.migrate(plan)).toEqual({
    fromVersion: 2,
    toVersion: 5,
    appliedVersions: [5],
  })
  expect(await env.storage.local.migrate(plan)).toEqual({
    fromVersion: 5,
    toVersion: 5,
    appliedVersions: [],
  })
  expect(skipped).not.toHaveBeenCalled()
  expect(applied).toHaveBeenCalledTimes(1)
  expect(env.set).toHaveBeenCalledTimes(1)
})

test.each([false, true])(
  'empty plans only read the version (namespace: %s)',
  async (namespaced) => {
    for (const version of [undefined, 0, 8, Number.MAX_SAFE_INTEGER]) {
      const key = namespaced ? `settings:${VERSION_KEY}` : VERSION_KEY
      const env = storageApi(version === undefined ? {} : { [key]: version })
      const area = namespaced
        ? env.storage.local.namespace('settings')
        : env.storage.local
      expect(await area.migrate([])).toEqual({
        fromVersion: version ?? 0,
        toVersion: version ?? 0,
        appliedVersions: [],
      })
      expect(env.get).toHaveBeenCalledTimes(1)
      expect(env.get).toHaveBeenCalledWith(key)
      expect(env.values.has(key)).toBe(version !== undefined)
      for (const method of [env.set, env.remove, env.clear, env.getKeys])
        expect(method).not.toHaveBeenCalled()
    }
  }
)

test.each(['__proto__', 'constructor', 'version:state'])(
  'custom marker %s stays scoped and supports special data keys',
  async (versionKey) => {
    const env = storageApi({
      private: 'root',
      'other:data': 'neighbor',
      '__proto__:historical': { old: true },
    })
    const area = env.storage.local.namespace<{ current: boolean }>('__proto__')
    const specialDataKey =
      versionKey === 'constructor' ? '__proto__' : 'constructor'
    expect(
      await area.migrate(
        [
          {
            version: 3,
            async migrate({ storage }) {
              expect(await storage.get()).toEqual({ historical: { old: true } })
              expect(
                await storage.getValue<{ old: boolean }>('historical')
              ).toEqual({
                old: true,
              })
              expect(
                await storage.get({ missing: false, historical: null })
              ).toEqual({
                missing: false,
                historical: { old: true },
              })
              await storage.set({ ['a:b']: 0, '': false, current: true })
              await storage.setValue(specialDataKey, null)
              expect(await storage.getValue('a:b', 42)).toBe(0)
              expect(await storage.getValue('', true)).toBe(false)
              expect(
                await storage.getValue(specialDataKey, 'fallback')
              ).toBeNull()
              await storage.remove(['historical', specialDataKey])
            },
          },
        ],
        { versionKey }
      )
    ).toEqual({
      fromVersion: 0,
      toVersion: 3,
      appliedVersions: [3],
    })
    expect(env.values.get(`__proto__:${versionKey}`)).toBe(3)
    expect(env.values.has(VERSION_KEY)).toBe(false)
    expect(env.values.get('private')).toBe('root')
    expect(env.values.get('other:data')).toBe('neighbor')
    const all = await env.storage.local.namespace('__proto__').get()
    expect(Object.hasOwn(all, versionKey)).toBe(true)
    expect(all[versionKey]).toBe(3)
    await area.clear()
    expect(env.values.has(`__proto__:${versionKey}`)).toBe(false)
    expect(Object.fromEntries(env.values)).toEqual({
      private: 'root',
      'other:data': 'neighbor',
    })
  }
)

test('root custom markers do not write the default marker', async () => {
  const env = storageApi({ schema: 1 })
  const migrate = mock(() => {})
  expect(
    await env.storage.local.migrate([{ version: 2, migrate }], {
      versionKey: 'schema',
    })
  ).toEqual({ fromVersion: 1, toVersion: 2, appliedVersions: [2] })
  expect(env.get).toHaveBeenCalledWith('schema')
  expect(env.set).toHaveBeenCalledWith({ schema: 2 })
  expect(env.values.has(VERSION_KEY)).toBe(false)
})

test('malformed plans, versions, duplicates and options reject before any I/O', async () => {
  const migrate = mock(() => {})
  const invalidPlans: unknown[] = [
    undefined,
    null,
    {},
    'steps',
    [null],
    [undefined],
    ['step'],
    Array(1),
    [{ version: 1 }],
    [{ version: 1, migrate: null }],
    [
      { version: 1, migrate },
      { version: 2, migrate },
      { version: 1, migrate },
    ],
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(
      (version) => [{ version, migrate }]
    ),
  ]
  for (const plan of invalidPlans) {
    const env = storageApi({ [VERSION_KEY]: 9 })
    await expect(
      env.storage.local.migrate(plan as readonly StorageMigration[])
    ).rejects.toBeInstanceOf(TypeError)
    env.expectNoIO()
  }
  for (const versionKey of ['', '  ', null, 0, false, {}, []]) {
    const env = storageApi()
    await expect(
      env.storage.local
        .namespace('settings')
        .migrate([{ version: 1, migrate }], {
          versionKey,
        } as StorageMigrationOptions)
    ).rejects.toBeInstanceOf(TypeError)
    env.expectNoIO()
  }
  expect(migrate).not.toHaveBeenCalled()
})

test.each([false, true])(
  'invalid stored versions include present undefined (namespace: %s)',
  async (namespaced) => {
    for (const value of [
      undefined,
      null,
      false,
      true,
      '1',
      [],
      {},
      -1,
      0.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      for (const empty of [false, true]) {
        const key = namespaced ? `settings:${VERSION_KEY}` : VERSION_KEY
        const env = storageApi({ [key]: value })
        const area = namespaced
          ? env.storage.local.namespace('settings')
          : env.storage.local
        const migrate = mock(() => {})
        await expect(
          area.migrate(empty ? [] : [{ version: 1, migrate }])
        ).rejects.toBeInstanceOf(TypeError)
        expect(env.values.has(key)).toBe(true)
        expect(env.get).toHaveBeenCalledTimes(1)
        expect(migrate).not.toHaveBeenCalled()
        expect(env.set).not.toHaveBeenCalled()
        expect(env.remove).not.toHaveBeenCalled()
      }
    }
  }
)

test('newer stored versions refuse downgrade even with an unsorted nonempty plan', async () => {
  const env = storageApi({ [VERSION_KEY]: 7 })
  const migrate = mock(() => {})
  await expect(
    env.storage.local.migrate([
      { version: 5, migrate },
      { version: 1, migrate },
    ])
  ).rejects.toThrow('newer')
  expect(migrate).not.toHaveBeenCalled()
  expect(env.set).not.toHaveBeenCalled()
  expect(env.values.get(VERSION_KEY)).toBe(7)
})

test.each(['sync', 'async'])(
  '%s callback failures preserve checkpoints and retry only unfinished steps',
  async (mode) => {
    const env = storageApi()
    const error = new Error('callback failed')
    let fail = true
    const first = mock(async ({ storage }: StorageMigrationContext) => {
      await storage.setValue('first', true)
    })
    const second = mock((context: StorageMigrationContext) => {
      expect([context.fromVersion, context.toVersion]).toEqual([1, 4])
      if (fail && mode === 'sync') throw error
      return (async () => {
        await context.storage.setValue('partial', true)
        if (fail) throw error
      })()
    })
    const last = mock(() => {})
    const plan = [
      { version: 8, migrate: last },
      { version: 1, migrate: first },
      { version: 4, migrate: second },
    ]
    await expect(env.storage.local.migrate(plan)).rejects.toBe(error)
    expect(env.values.get(VERSION_KEY)).toBe(1)
    expect(env.values.get('first')).toBe(true)
    expect(env.values.has('partial')).toBe(mode === 'async')
    expect(last).not.toHaveBeenCalled()
    fail = false
    expect(await env.wrap().local.migrate(plan)).toEqual({
      fromVersion: 1,
      toVersion: 8,
      appliedVersions: [4, 8],
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(last).toHaveBeenCalledTimes(1)
  }
)

test('failed marker writes keep callback writes but do not advance the checkpoint', async () => {
  const env = storageApi()
  const error = new Error('checkpoint quota exceeded')
  env.failWrite(VERSION_KEY, 2, error)
  const first = mock(() => {})
  const second = mock(async ({ storage }: StorageMigrationContext) => {
    await storage.setValue('partial', { migrated: true })
  })
  const last = mock(() => {})
  const plan = [
    { version: 1, migrate: first },
    { version: 2, migrate: second },
    { version: 3, migrate: last },
  ]
  await expect(env.storage.local.migrate(plan)).rejects.toBe(error)
  expect(env.values.get(VERSION_KEY)).toBe(1)
  expect(env.values.get('partial')).toEqual({ migrated: true })
  expect(last).not.toHaveBeenCalled()
  expect(await env.wrap().local.migrate(plan)).toEqual({
    fromVersion: 1,
    toVersion: 3,
    appliedVersions: [2, 3],
  })
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(2)
  expect(last).toHaveBeenCalledTimes(1)
})

test('read failures propagate unchanged and release the migration queue', async () => {
  const env = storageApi()
  const error = new Error('storage inaccessible')
  env.failRead(error)
  const migrate = mock(() => {})
  await expect(
    env.storage.local.migrate([{ version: 1, migrate }])
  ).rejects.toBe(error)
  expect(migrate).not.toHaveBeenCalled()
  expect(env.set).not.toHaveBeenCalled()
  expect(await env.wrap().local.migrate([{ version: 1, migrate }])).toEqual({
    fromVersion: 0,
    toVersion: 1,
    appliedVersions: [1],
  })
})

test.each([
  { namespaced: false, versionKey: VERSION_KEY, nativeKeys: true },
  { namespaced: false, versionKey: '__proto__', nativeKeys: false },
  { namespaced: true, versionKey: VERSION_KEY, nativeKeys: false },
  { namespaced: true, versionKey: 'version:state', nativeKeys: true },
])(
  'callback facade protects its marker and clear preserves it: %j',
  async ({ namespaced, versionKey, nativeKeys }) => {
    const prefix = namespaced ? 'settings:' : ''
    const key = `${prefix}${versionKey}`
    const env = storageApi(
      {
        [key]: 1,
        [`${prefix}data`]: 'old',
        ...(namespaced ? { private: 'root', 'other:data': 'neighbor' } : {}),
      },
      nativeKeys
    )
    const area = namespaced
      ? env.storage.local.namespace('settings')
      : env.storage.local
    const error = new Error('failed after clear')
    let fail = true
    const migrate = mock(async ({ storage }: StorageMigrationContext) => {
      expect(Object.keys(storage).sort()).toEqual([
        'clear',
        'get',
        'getValue',
        'remove',
        'set',
        'setValue',
      ])
      expect('migrate' in storage).toBe(false)
      expect('namespace' in storage).toBe(false)
      expect(await storage.getValue<number>(versionKey)).toBe(1)
      const writes = env.set.mock.calls.length
      const removals = env.remove.mock.calls.length
      await expect(
        storage.set({ data: 'changed', [versionKey]: 99 })
      ).rejects.toBeInstanceOf(TypeError)
      await expect(storage.setValue(versionKey, 99)).rejects.toBeInstanceOf(
        TypeError
      )
      await expect(storage.remove(versionKey)).rejects.toBeInstanceOf(TypeError)
      for (const keys of [
        ['data', versionKey],
        [versionKey, 'data'],
      ])
        await expect(storage.remove(keys)).rejects.toBeInstanceOf(TypeError)
      expect(env.set).toHaveBeenCalledTimes(writes)
      expect(env.remove).toHaveBeenCalledTimes(removals)
      expect(env.values.get(key)).toBe(1)
      await storage.clear()
      expect(await storage.get()).toEqual({ [versionKey]: 1 })
      expect(env.clear).not.toHaveBeenCalled()
      if (fail) throw error
    })
    const plan = [{ version: 2, migrate }]
    await expect(area.migrate(plan, { versionKey })).rejects.toBe(error)
    expect(env.values.get(key)).toBe(1)
    expect(env.values.has(`${prefix}data`)).toBe(false)
    if (namespaced) {
      expect(env.values.get('private')).toBe('root')
      expect(env.values.get('other:data')).toBe('neighbor')
    }
    fail = false
    expect(await area.migrate(plan, { versionKey })).toEqual({
      fromVersion: 1,
      toVersion: 2,
      appliedVersions: [2],
    })
    await area.clear()
    expect(env.values.has(key)).toBe(false)
    expect(await area.migrate([], { versionKey })).toEqual({
      fromVersion: 0,
      toVersion: 0,
      appliedVersions: [],
    })
  }
)

test.each(['root wrappers', 'namespace handles', 'root qualified marker'])(
  'concurrent migrations serialize across %s and reread the saved version',
  async (kind) => {
    const env = storageApi()
    const wrapper = env.wrap()
    const firstArea =
      kind === 'root wrappers'
        ? env.storage.local
        : env.storage.local.namespace('settings')
    const secondArea =
      kind === 'namespace handles'
        ? wrapper.local.namespace('settings')
        : wrapper.local
    const options =
      kind === 'root qualified marker'
        ? { versionKey: `settings:${VERSION_KEY}` }
        : undefined
    const hold = holdMigration()
    const last = mock(() => {})
    const plan = [
      { version: 1, migrate: hold.migrate },
      { version: 2, migrate: last },
    ]
    const first = firstArea.migrate(plan)
    let second: ReturnType<typeof secondArea.migrate> | undefined
    try {
      await hold.entered.promise
      const reads = env.get.mock.calls.length
      second = secondArea.migrate(plan, options)
      expect(env.get).toHaveBeenCalledTimes(reads)
      expect(last).not.toHaveBeenCalled()
      hold.release.resolve()
      expect(await first).toEqual({
        fromVersion: 0,
        toVersion: 2,
        appliedVersions: [1, 2],
      })
      expect(await second).toEqual({
        fromVersion: 2,
        toVersion: 2,
        appliedVersions: [],
      })
      expect(hold.migrate).toHaveBeenCalledTimes(1)
      expect(last).toHaveBeenCalledTimes(1)
    } finally {
      hold.release.resolve()
      await Promise.allSettled([first, ...(second ? [second] : [])])
    }
  },
  2000
)

test('a queued invocation snapshots its steps before waiting', async () => {
  const env = storageApi()
  const hold = holdMigration()
  const first = env.storage.local.migrate([
    { version: 1, migrate: hold.migrate },
  ])
  const original = mock(() => {})
  const replacement = mock(() => {})
  const step = { version: 2, migrate: original }
  const plan = [step]
  let second: ReturnType<typeof env.storage.local.migrate> | undefined
  try {
    await hold.entered.promise
    second = env.wrap().local.migrate(plan)
    step.version = 99
    step.migrate = replacement
    plan.length = 0
    hold.release.resolve()
    await first
    expect(await second).toEqual({
      fromVersion: 1,
      toVersion: 2,
      appliedVersions: [2],
    })
    expect(original).toHaveBeenCalledTimes(1)
    expect(replacement).not.toHaveBeenCalled()
  } finally {
    hold.release.resolve()
    await Promise.allSettled([first, ...(second ? [second] : [])])
  }
}, 2000)

test.each(['callback', 'checkpoint'])(
  'a queued successor proceeds after %s failure',
  async (failure) => {
    const env = storageApi()
    const entered = deferred()
    const release = deferred()
    const error = new Error('first invocation failed')
    if (failure === 'checkpoint') env.failWrite(VERSION_KEY, 2, error)
    const first = env.storage.local.migrate([
      { version: 1, migrate: () => {} },
      {
        version: 2,
        async migrate({ storage }) {
          await storage.setValue('partial', true)
          entered.resolve()
          await release.promise
          if (failure === 'callback') throw error
        },
      },
    ])
    const rejected = (async () => {
      try {
        await first
        return undefined
      } catch (cause) {
        return cause
      }
    })()
    let second: ReturnType<typeof env.storage.local.migrate> | undefined
    try {
      await entered.promise
      const migrate = mock(({ fromVersion }: StorageMigrationContext) => {
        expect(fromVersion).toBe(1)
      })
      second = env.wrap().local.migrate([{ version: 2, migrate }])
      expect(migrate).not.toHaveBeenCalled()
      release.resolve()
      expect(await rejected).toBe(error)
      expect(await second).toEqual({
        fromVersion: 1,
        toVersion: 2,
        appliedVersions: [2],
      })
      expect(migrate).toHaveBeenCalledTimes(1)
      expect(env.values.get('partial')).toBe(true)
    } finally {
      release.resolve()
      await Promise.allSettled([rejected, ...(second ? [second] : [])])
    }
  },
  2000
)

test.each(['native identities', 'marker keys', 'namespaces'])(
  'independent %s proceed while another migration is paused',
  async (kind) => {
    const env = storageApi()
    const other = kind === 'native identities' ? storageApi() : env
    const firstArea =
      kind === 'namespaces'
        ? env.storage.local.namespace('first')
        : env.storage.local
    const secondArea =
      kind === 'namespaces'
        ? other.wrap().local.namespace('second')
        : other.wrap().local
    const hold = holdMigration()
    const first = firstArea.migrate([{ version: 1, migrate: hold.migrate }])
    try {
      await hold.entered.promise
      const migrate = mock(() => {})
      expect(
        await secondArea.migrate(
          [{ version: 1, migrate }],
          kind === 'marker keys' ? { versionKey: 'other-version' } : undefined
        )
      ).toEqual({ fromVersion: 0, toVersion: 1, appliedVersions: [1] })
      expect(migrate).toHaveBeenCalledTimes(1)
      expect(
        env.values.has(
          kind === 'namespaces' ? `first:${VERSION_KEY}` : VERSION_KEY
        )
      ).toBe(false)
      hold.release.resolve()
      expect(await first).toEqual({
        fromVersion: 0,
        toVersion: 1,
        appliedVersions: [1],
      })
    } finally {
      hold.release.resolve()
      await Promise.allSettled([first])
    }
  },
  2000
)

test('managed root and namespace migrations reject before I/O including empty plans', async () => {
  const env = storageApi()
  const migrate = mock(() => {})
  for (const area of [
    env.storage.managed,
    env.storage.managed.namespace('policy'),
  ]) {
    for (const plan of [[], [{ version: 1, migrate }]])
      await expect(area.migrate(plan)).rejects.toBeInstanceOf(
        UnsupportedOperationError
      )
  }
  env.expectNoIO()
  expect(migrate).not.toHaveBeenCalled()
  expect(await env.storage.local.migrate([{ version: 1, migrate }])).toEqual({
    fromVersion: 0,
    toVersion: 1,
    appliedVersions: [1],
  })
})

test('dispose does not cancel a migration or release its lock early', async () => {
  const env = storageApi()
  const hold = holdMigration()
  const first = env.storage.local.migrate([
    { version: 1, migrate: hold.migrate },
  ])
  let second: ReturnType<typeof env.storage.local.migrate> | undefined
  try {
    await hold.entered.promise
    env.storage.dispose()
    env.storage.dispose()
    const next = mock(() => {})
    const reads = env.get.mock.calls.length
    second = env.wrap().local.migrate([{ version: 2, migrate: next }])
    expect(env.get).toHaveBeenCalledTimes(reads)
    expect(next).not.toHaveBeenCalled()
    hold.release.resolve()
    expect(await first).toEqual({
      fromVersion: 0,
      toVersion: 1,
      appliedVersions: [1],
    })
    expect(await second).toEqual({
      fromVersion: 1,
      toVersion: 2,
      appliedVersions: [2],
    })
    expect(
      await env.storage.local.migrate([{ version: 3, migrate: next }])
    ).toEqual({
      fromVersion: 2,
      toVersion: 3,
      appliedVersions: [3],
    })
    expect(next).toHaveBeenCalledTimes(2)
  } finally {
    hold.release.resolve()
    await Promise.allSettled([first, ...(second ? [second] : [])])
  }
}, 2000)
