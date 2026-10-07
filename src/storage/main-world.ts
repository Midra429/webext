import type Browser from 'webextension-polyfill'
import type { MainWorldOptions } from '../messaging'
import type {
  NamespacedStorageArea,
  StorageArea,
  StorageHelpers,
} from './index'

import { UnsupportedOperationError } from '../errors'
import { errorResponse, successResponse } from '../messaging/protocol'
import { sendMessage } from '../messaging/transport'
import { createWindowTransport } from '../messaging/window'
import { assertStorageNamespace } from './namespace'

/** ストレージの実領域名。MAIN worldのハンドルは領域の利用可否を保証しません。 */
export type StorageAreaName = 'local' | 'sync' | 'managed' | 'session'

/** MAIN worldへ公開するデータ名前空間。未指定の領域・名前空間は公開しません。 */
export interface MainWorldStorageScope {
  area: StorageAreaName
  /** 保存キーの接頭辞。通信設定のnamespaceとは別です。空文字・コロンは禁止。 */
  namespace: string
  /** 既定値はfalse。managedはtrueを指定しても書き込みを許可しません。 */
  writable?: boolean
}

/** コンテンツスクリプトで登録するストレージ中継。ページも通信を読み書きできます。 */
export interface MainWorldStorageBridgeOptions extends MainWorldOptions {
  scopes: readonly MainWorldStorageScope[]
  /** JSON化できない変更通知などの報告先。既定はconsole.error。 */
  onError?: (error: unknown) => void
}

/** 拡張APIを使わないMAIN worldクライアントの設定。 */
export interface MainWorldStorageOptions extends MainWorldOptions {
  /** 各操作の応答待機上限。既定10秒。送信済みの保存処理はキャンセルしません。 */
  timeoutMs?: number
  /** 変更監視リスナーの例外などの報告先。既定はconsole.error。 */
  onError?: (error: unknown) => void
}

/**
 * MAIN worldから操作する名前空間。値の転送はメッセージングと同じJSON制約です。
 * watchはローカル登録のみで、権限検証・現在値の通知は行いません。
 * 中継停止中の変更は再送しません。nativeイベント・同期capabilities・migrateは公開しません。
 */
export type MainWorldStorageArea<
  Schema extends object | undefined = undefined,
> = Omit<NamespacedStorageArea<Schema>, 'capabilities' | 'migrate'> & {
  /** 公開許可と領域の存在を確認し、補完方式を取得します。未許可なら拒否します。 */
  getCapabilities(): Promise<StorageHelpers['capabilities']>
}

/**
 * MAIN world用の領域ハンドル。利用には同じフレームのストレージ中継が必要です。
 * sessionを含む各領域の存在・アクセス権限は保証せず、未公開の操作は拒否されます。
 */
export type MainWorldStorage = {
  readonly [K in StorageAreaName]: {
    namespace<Schema extends object | undefined = undefined>(
      name: string
    ): MainWorldStorageArea<Schema>
  }
} & {
  /** 応答待機・監視を終端的に破棄します。既に開始したネイティブ処理は継続します。 */
  dispose(): void
}

const CHANNEL = '@midra/webext/storage'
const AREA_NAMES: readonly StorageAreaName[] = [
  'local',
  'sync',
  'managed',
  'session',
]
const scopeId = (area: string, namespace: string) =>
  JSON.stringify([area, namespace])

function transportOptions(options: MainWorldOptions): MainWorldOptions {
  if (typeof options.namespace !== 'string' || !options.namespace.trim())
    throw new TypeError('MAIN world namespace must not be empty')
  // メッセージング中継と独立した通信経路を使う。
  return { ...options, namespace: `${options.namespace}/storage` }
}

function report(
  options: { onError?: (error: unknown) => void },
  error: unknown
) {
  try {
    ;(options.onError ?? console.error)(error)
  } catch {
    // 報告先の例外で他の監視リスナーへの通知を中断しない。
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStorageKeys(value: unknown): value is string | string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((key) => typeof key === 'string'))
  )
}

/** @internal コンテンツスクリプトの実領域を限定公開します。 */
export function createStorageBridge(
  areas: Partial<Record<StorageAreaName, StorageArea>>,
  storage: Browser.Storage.Static,
  options: MainWorldStorageBridgeOptions
): () => void {
  const transport = transportOptions(options)
  if (!Array.isArray(options.scopes) || options.scopes.length === 0)
    throw new TypeError('MAIN world storage scopes must not be empty')
  if (!storage.onChanged)
    throw new UnsupportedOperationError('storage.bridgeMainWorld')
  const grants = new Map<
    string,
    {
      area: StorageAreaName
      namespace: string
      scoped: NamespacedStorageArea
      writable: boolean
    }
  >()
  for (const scope of options.scopes) {
    if (
      !isRecord(scope) ||
      !AREA_NAMES.includes(scope.area as StorageAreaName) ||
      (scope.writable !== undefined && typeof scope.writable !== 'boolean')
    )
      throw new TypeError('Invalid MAIN world storage scope')
    const area = scope.area as StorageAreaName
    const native = areas[area]
    if (!native) throw new UnsupportedOperationError(`storage.${area}`)
    const namespace = scope.namespace as string
    const scoped = native.namespace(namespace)
    const id = scopeId(area, namespace)
    if (grants.has(id))
      throw new TypeError('Duplicate MAIN world storage scope')
    grants.set(id, {
      area,
      namespace,
      scoped,
      writable: scope.writable === true && area !== 'managed',
    })
  }
  let stopped = false
  const endpoint = createWindowTransport(
    transport,
    'content',
    (message, _sender, target, respond) => {
      void (async () => {
        try {
          if (
            target !== 'content-script' ||
            message.channel !== CHANNEL ||
            message.type !== 'request'
          )
            throw new TypeError('Invalid MAIN world storage request')
          const request = message.payload
          if (
            !isRecord(request) ||
            typeof request.area !== 'string' ||
            typeof request.namespace !== 'string' ||
            typeof request.operation !== 'string'
          )
            throw new TypeError('Invalid MAIN world storage request')
          const grant = grants.get(scopeId(request.area, request.namespace))
          if (!grant) throw new Error('MAIN world storage scope is not allowed')
          const { scoped, writable } = grant
          const { operation, argument } = request
          if (['set', 'remove', 'clear'].includes(operation) && !writable)
            throw new Error('MAIN world storage scope is read-only')
          let value: unknown
          switch (operation) {
            case 'get':
              if (
                argument != null &&
                !isStorageKeys(argument) &&
                !isRecord(argument)
              )
                throw new TypeError('Invalid storage get keys')
              value = await scoped.get(argument ?? null)
              break
            case 'set':
              if (!isRecord(argument))
                throw new TypeError('Storage items must be an object')
              await scoped.set(argument)
              break
            case 'remove':
              if (!isStorageKeys(argument))
                throw new TypeError('Invalid storage remove keys')
              await scoped.remove(argument)
              break
            case 'clear':
              await scoped.clear()
              break
            case 'getKeys':
              value = await scoped.getKeys()
              break
            case 'getBytesInUse':
              if (argument != null && !isStorageKeys(argument))
                throw new TypeError('Invalid storage byte count keys')
              value = await scoped.getBytesInUse(argument ?? null)
              break
            case 'getCapabilities':
              value = scoped.capabilities
              break
            default:
              throw new TypeError('Unknown MAIN world storage operation')
          }
          if (!stopped) respond(successResponse(value))
        } catch (error) {
          if (!stopped) respond(errorResponse(error))
        }
      })()
    }
  )
  const onChanged = (
    changes: Record<string, Browser.Storage.StorageChange>,
    areaName: string
  ) => {
    if (stopped) return
    const scopedChanges = new Map<
      string,
      [string, Browser.Storage.StorageChange][]
    >()
    // 名前空間にコロンを許可しないため、変更を一度だけ走査して公開先を特定できる。
    for (const key of Object.keys(changes)) {
      const separator = key.indexOf(':')
      if (separator < 0) continue
      const id = scopeId(areaName, key.slice(0, separator))
      if (!grants.has(id)) continue
      let entries = scopedChanges.get(id)
      if (!entries) {
        entries = []
        scopedChanges.set(id, entries)
      }
      entries.push([key.slice(separator + 1), changes[key]!])
    }
    for (const [id, grant] of grants) {
      if (stopped) break
      const entries = scopedChanges.get(id)
      if (!entries) continue
      try {
        endpoint.notify({
          __webext_rpc__: 1,
          channel: CHANNEL,
          type: 'changed',
          empty: false,
          payload: {
            area: grant.area,
            namespace: grant.namespace,
            changes: Object.fromEntries(entries),
          },
        })
      } catch (error) {
        report(options, error)
      }
    }
  }
  try {
    storage.onChanged.addListener(onChanged)
  } catch (error) {
    endpoint.dispose()
    throw error
  }
  return () => {
    if (stopped) return
    stopped = true
    endpoint.dispose()
    storage.onChanged.removeListener(onChanged)
    grants.clear()
  }
}

/**
 * 拡張APIがないMAIN worldで名前空間付きストレージを作成します。
 * content側でstorage.bridgeMainWorldを明示登録してください。
 * ページは通信を観測・偽装できます。秘密情報を公開しないでください。
 */
export function createMainWorldStorage(
  options: MainWorldStorageOptions
): MainWorldStorage {
  type Watcher = {
    key: string
    listener: (value: unknown, previous: unknown) => void
  }
  const watchers = new Map<string, Set<Watcher>>()
  let disposed = false
  const endpoint = createWindowTransport(
    transportOptions(options),
    'main',
    (message) => {
      if (disposed || message.channel !== CHANNEL || message.type !== 'changed')
        return
      const payload = message.payload
      if (
        !isRecord(payload) ||
        typeof payload.area !== 'string' ||
        typeof payload.namespace !== 'string' ||
        !isRecord(payload.changes)
      )
        return
      const changes = payload.changes
      const entries = watchers.get(scopeId(payload.area, payload.namespace))
      for (const watcher of [...(entries ?? [])]) {
        if (disposed) break
        if (!entries?.has(watcher) || !Object.hasOwn(changes, watcher.key))
          continue
        const change = changes[watcher.key]
        if (!isRecord(change)) continue
        try {
          watcher.listener(change.newValue, change.oldValue)
        } catch (error) {
          report(options, error)
        }
      }
    }
  )
  const areas = Object.fromEntries(
    AREA_NAMES.map((area) => [
      area,
      {
        namespace(name: string): MainWorldStorageArea {
          if (disposed) throw new Error('MAIN world storage is disposed')
          assertStorageNamespace(name)
          const request = <T>(
            operation: string,
            argument?: unknown
          ): Promise<T> => {
            if (disposed)
              return Promise.reject(new Error('MAIN world storage is disposed'))
            return sendMessage<T>(
              undefined,
              CHANNEL,
              'request',
              { area, namespace: name, operation, argument },
              { timeoutMs: options.timeoutMs },
              (message) => endpoint.send(message, {}, 'content-script')
            )
          }
          return {
            getCapabilities: () => request('getCapabilities'),
            get: (keys = null) => request('get', keys),
            set: (items) => request('set', items),
            remove: (keys) => request('remove', keys),
            clear: () => request('clear'),
            getKeys: () => request('getKeys'),
            getBytesInUse: (keys = null) => request('getBytesInUse', keys),
            async getValue<T>(key: string, defaultValue?: T): Promise<T> {
              if (typeof key !== 'string')
                throw new TypeError('Storage key must be a string')
              const values = await request<Record<string, unknown>>('get', key)
              return (
                Object.hasOwn(values, key) ? values[key] : defaultValue
              ) as T
            },
            async setValue(key, value) {
              if (typeof key !== 'string')
                throw new TypeError('Storage key must be a string')
              if (value === undefined)
                throw new TypeError('Storage value must be JSON-compatible')
              await request('set', { [key]: value })
            },
            watch(key, listener) {
              if (disposed) throw new Error('MAIN world storage is disposed')
              if (typeof key !== 'string' || typeof listener !== 'function')
                throw new TypeError('Invalid storage watch arguments')
              const id = scopeId(area, name)
              let entries = watchers.get(id)
              if (!entries) {
                entries = new Set()
                watchers.set(id, entries)
              }
              const watcher: Watcher = {
                key,
                listener: listener as Watcher['listener'],
              }
              entries.add(watcher)
              return () => {
                entries.delete(watcher)
                if (watchers.get(id) === entries && !entries.size)
                  watchers.delete(id)
              }
            },
          }
        },
      },
    ])
  ) as Omit<MainWorldStorage, 'dispose'>
  return {
    ...areas,
    dispose() {
      if (disposed) return
      disposed = true
      for (const entries of watchers.values()) entries.clear()
      watchers.clear()
      endpoint.dispose()
    },
  }
}
