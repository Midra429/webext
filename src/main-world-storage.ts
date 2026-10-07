import type Browser from 'webextension-polyfill'
import type { MainWorldOptions } from './messaging'
import type {
  NamespacedStorageArea,
  StorageArea,
  StorageHelpers,
} from './storage'

import { UnsupportedOperationError } from './errors'
import { encode } from './messaging/serialization'
import { sendMessage } from './messaging/transport'
import { createWindowTransport, errorResponse } from './messaging/window'

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
 * 中継停止中の変更は再送しません。nativeイベント・同期capabilitiesは公開しません。
 */
export type MainWorldStorageArea<
  Schema extends object | undefined = undefined,
> = Omit<NamespacedStorageArea<Schema>, 'capabilities'> & {
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(value: unknown): value is string | string[] {
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
      !record(scope) ||
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
            !record(request) ||
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
              if (argument != null && !keys(argument) && !record(argument))
                throw new TypeError('Invalid storage get keys')
              value = await scoped.get(argument ?? null)
              break
            case 'set':
              if (!record(argument))
                throw new TypeError('Storage items must be an object')
              await scoped.set(argument)
              break
            case 'remove':
              if (!keys(argument))
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
              if (argument != null && !keys(argument))
                throw new TypeError('Invalid storage byte count keys')
              value = await scoped.getBytesInUse(argument ?? null)
              break
            case 'getCapabilities':
              value = scoped.capabilities
              break
            default:
              throw new TypeError('Unknown MAIN world storage operation')
          }
          if (!stopped)
            respond({
              __webext_rpc__: 1,
              ok: true,
              value: encode(value),
              empty: value === undefined,
            })
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
    for (const grant of grants.values()) {
      if (grant.area !== areaName) continue
      const prefix = `${grant.namespace}:`
      const filtered = Object.fromEntries(
        Object.entries(changes)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key.slice(prefix.length), value])
      )
      if (!Object.keys(filtered).length) continue
      try {
        endpoint.notify({
          __webext_rpc__: 1,
          channel: CHANNEL,
          type: 'changed',
          empty: false,
          payload: {
            area: grant.area,
            namespace: grant.namespace,
            changes: filtered,
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
        !record(payload) ||
        typeof payload.area !== 'string' ||
        typeof payload.namespace !== 'string' ||
        !record(payload.changes)
      )
        return
      const changes = payload.changes
      const entries = watchers.get(scopeId(payload.area, payload.namespace))
      for (const watcher of [...(entries ?? [])]) {
        if (disposed) break
        if (!entries?.has(watcher) || !Object.hasOwn(changes, watcher.key))
          continue
        const change = changes[watcher.key]
        if (!record(change)) continue
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
          if (
            typeof name !== 'string' ||
            name.length === 0 ||
            name.includes(':')
          )
            throw new TypeError(
              'Storage namespace must be non-empty and contain no colon'
            )
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
