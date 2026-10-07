import type {
  MainWorldStorage,
  MainWorldStorageArea,
  NamespacedStorageArea,
  WebExtStorage,
} from '../src'

import { expectTypeOf } from 'bun:test'

interface Settings {
  theme: 'system' | 'light' | 'dark'
  count: number
  enabled: boolean
  note?: string | null
}

// compileでのみ確認する。未保存・削除・既定値の型も両worldで同じ扱いにする。
function typedScope(
  scope: NamespacedStorageArea<Settings> | MainWorldStorageArea<Settings>
) {
  expectTypeOf(scope.getValue('theme')).toEqualTypeOf<
    Promise<Settings['theme'] | undefined>
  >()
  expectTypeOf(scope.getValue('theme', 'system')).toEqualTypeOf<
    Promise<Settings['theme']>
  >()
  expectTypeOf(scope.getValue('count', 0)).toEqualTypeOf<Promise<number>>()
  expectTypeOf(scope.getValue('count', undefined)).toEqualTypeOf<
    Promise<number | undefined>
  >()
  expectTypeOf(scope.getValue('note', '')).toEqualTypeOf<
    Promise<string | null>
  >()
  expectTypeOf(scope.get()).toEqualTypeOf<Promise<Partial<Settings>>>()
  expectTypeOf(scope.get(null)).toEqualTypeOf<Promise<Partial<Settings>>>()
  expectTypeOf(scope.get('theme')).toEqualTypeOf<
    Promise<Partial<Pick<Settings, 'theme'>>>
  >()
  expectTypeOf(scope.get(['theme', 'count'] as const)).toEqualTypeOf<
    Promise<Partial<Pick<Settings, 'theme' | 'count'>>>
  >()
  expectTypeOf(scope.get({ count: 0 })).toEqualTypeOf<
    Promise<{ count: number }>
  >()
  expectTypeOf(scope.get({ note: '' })).toEqualTypeOf<
    Promise<{ note: string | null }>
  >()
  expectTypeOf(scope.get({ note: undefined })).toEqualTypeOf<
    Promise<{ note: string | null | undefined }>
  >()
  expectTypeOf(scope.getKeys()).toEqualTypeOf<Promise<string[]>>()
  expectTypeOf(scope.get({ theme: 'system' })).toEqualTypeOf<
    Promise<{ theme: Settings['theme'] }>
  >()
  const partial: Partial<Settings> = { count: 0 }
  scope.set(partial)
  expectTypeOf(scope.get(partial)).toEqualTypeOf<Promise<Partial<Settings>>>()
  scope.setValue('theme', 'dark')
  scope.setValue('count', 10)
  scope.set({ theme: 'light', enabled: true })
  scope.remove(['theme', 'count'] as const)
  scope.getBytesInUse(['theme', 'count'] as const)
  scope.watch('count', (value, previous) => {
    expectTypeOf(value).toEqualTypeOf<number | undefined>()
    expectTypeOf(previous).toEqualTypeOf<number | undefined>()
  })

  // @ts-expect-error 未定義のキーは取得できない。
  scope.getValue('missing')
  // @ts-expect-error 値からキーの型を広げて、間違った値を受け入れてはいけない。
  scope.setValue('theme', 123)
  // @ts-expect-error 既定値も選んだキーの値型に従う。
  scope.getValue('count', 'fallback')
  // @ts-expect-error 既定値は定義済みのリテラルだけ。
  scope.getValue('theme', 'invalid')
  // @ts-expect-error スキーマ指定後に値型を手動で上書きできない。
  scope.getValue<number>('theme')
  // @ts-expect-error 辞書の値型も検証する。
  scope.set({ count: 'wrong' })
  // @ts-expect-error 辞書の余分なキーも拒否する。
  scope.set({ count: 1, missing: true })
  const extra = { count: 1, missing: true }
  // @ts-expect-error 変数経由の余分なキーも拒否する。
  scope.set(extra)
  // @ts-expect-error getの既定値の辞書もスキーマに従う。
  scope.get({ count: 'wrong' })
  // @ts-expect-error getの既定値の辞書でも余分なキーを拒否する。
  scope.get(extra)
  // @ts-expect-error 部分取得のキーを検証する。
  scope.get(['theme', 'missing'])
  // @ts-expect-error 削除のキーを検証する。
  scope.remove('missing')
  // @ts-expect-error 使用量計測のキーを検証する。
  scope.getBytesInUse('missing')
  // @ts-expect-error 監視の値型はキーから決まる。
  scope.watch('count', (_value: string | undefined) => {})
}

export function storageTypes(storage: WebExtStorage, main: MainWorldStorage) {
  typedScope(storage.local.namespace<Settings>('settings'))
  typedScope(storage.sync.namespace<Settings>('settings'))
  typedScope(main.local.namespace<Settings>('settings'))
  typedScope(main.session.namespace<Settings>('settings'))
  expectTypeOf(
    main.local.namespace<Settings>('settings').getCapabilities()
  ).toEqualTypeOf<Promise<NamespacedStorageArea<Settings>['capabilities']>>()

  // スキーマ未指定の従来の型引数・自由なキーは維持する。
  const legacy = storage.local.namespace('legacy')
  expectTypeOf(legacy.getValue<number>('count')).toEqualTypeOf<
    Promise<number | undefined>
  >()
  legacy.setValue('arbitrary', { any: 'value' })
  legacy.watch<string>('arbitrary', () => {})
  const legacyMain = main.local.namespace('legacy')
  expectTypeOf(legacyMain.getValue<number>('count')).toEqualTypeOf<
    Promise<number | undefined>
  >()
  legacyMain.watch<string>('arbitrary', () => {})
}
