import type Browser from 'webextension-polyfill'
import type { MainWorldStorageBridgeOptions } from './main-world'

import { createDisposables } from '../disposables'
import { UnsupportedOperationError } from '../errors'
import { facade } from '../facade'
import { createStorageBridge } from './main-world'
import { createNamespace, estimateBytes } from './namespace'

/**
 * 利用可能なストレージ領域に追加する共通ヘルパー。
 *
 * @remarks
 * `storage` 権限が必要です。領域へのアクセス制限・保存形式・クォータはネイティブAPIに従います。
 * Promiseを返すメソッドの失敗は拒否として伝播し、`watch()` の登録失敗は同期例外です。
 * 型引数 `T` は実行時のデータ検証・変換を行いません。
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage
 */
export interface StorageHelpers {
  /** 補完メソッドの実装方式。権限・領域へのアクセス可否を保証するものではありません。 */
  readonly capabilities: {
    /** `native` はネイティブ呼び出し、`polyfilled` は全値の取得によるキー列挙。 */
    readonly getKeys: 'native' | 'polyfilled'
    /** `native` はネイティブの計測、`estimated` はJSONに基づく推定。 */
    readonly getBytesInUse: 'native' | 'estimated'
  }
  /**
   * 領域内の全キーを取得します。
   *
   * @returns キーの配列。ネイティブが未対応なら `get(null)` で全値を読み、キーを列挙します。
   * @throws ネイティブの読み取りエラーでPromiseが拒否されます。
   * @remarks 補完時はキーだけでなく全値の読み取りコストが発生します。
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea
   */
  getKeys(): Promise<string[]>
  /**
   * 指定キーの使用バイト数を取得し、ネイティブが未対応なら推定します。
   *
   * @param keys - 対象キー。省略・`null` は全件、空配列は対象なし。
   * @returns ネイティブの計測値、またはキーとJSON化した値のUTF-8バイト数の合計。
   * @throws 読み取り・JSON化の失敗でPromiseが拒否されます。
   * @remarks
   * `capabilities.getBytesInUse` で実装方式を確認できます。推定値はディスク使用量でも
   * ブラウザのクォータ計測値でもなく、クォータ超過の判定には使えません。
   * 特にsession領域のメモリ使用量とは異なります。
   * @see https://developer.chrome.com/docs/extensions/reference/api/storage
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/get
   */
  getBytesInUse(keys?: string | string[] | null): Promise<number>
  /**
   * 単一キーの値を取得します。
   *
   * @typeParam T - 期待する値の型。実行時検証は行いません。
   * @param key - 取得するキー。
   * @returns 保存値。キーが存在しなければ `undefined`。
   * @throws ネイティブの読み取りエラーでPromiseが拒否されます。
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/get
   */
  getValue<T>(key: string): Promise<T | undefined>
  /**
   * 単一キーの値を、未保存時の既定値付きで取得します。
   *
   * @typeParam T - 期待する値の型。保存値の実行時検証は行いません。
   * @param key - 取得するキー。
   * @param defaultValue - キーが存在しない場合だけ返す値。ストレージには保存しません。
   * @returns 保存値、または既定値。既存の `null` などは既定値に置き換えません。
   * @throws ネイティブの読み取りエラーでPromiseが拒否されます。既定値ではエラーを補いません。
   * @example
   * ```ts
   * const theme = await webext.storage.local.getValue('theme', 'system')
   * ```
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/get
   */
  getValue<T>(key: string, defaultValue: T): Promise<T>
  /**
   * 単一キーの値をネイティブの `set()` で保存・更新します。
   *
   * @typeParam T - 保存する値の型。実行時検証は行いません。
   * @param key - 保存先のキー。
   * @param value - ネイティブのストレージAPIで保存可能な値。
   * @returns 保存完了時に解決するPromise。
   * @throws 保存形式・権限・クォータなどのネイティブエラーでPromiseが拒否されます。
   * managed領域は読み取り専用のため書き込みが拒否されます。
   * @see https://developer.chrome.com/docs/extensions/reference/api/storage
   */
  setValue<T>(key: string, value: T): Promise<void>
  /**
   * この領域・キーに対するネイティブの変更通知を監視します。
   *
   * @typeParam T - 通知値の期待する型。実行時検証は行いません。
   * @param key - 監視するキー。
   * @param listener - 新しい値と以前の値を受け取る関数。削除後の値・追加前の値は `undefined`。
   * @returns この監視だけを解除する関数。繰り返し呼んでも解除処理は一度だけです。
   * @throws {UnsupportedOperationError} `storage.onChanged` がなければ同期的に送出します。
   * @remarks
   * 登録時に現在値は通知しません。値の比較や重複排除は行わず、Firefoxでは値が変わらなくても
   * 通知される場合があります。managedの通知可否もネイティブに従います。
   * `storage.dispose()` / `webext.dispose()` でもこのヘルパーの監視を解除します。
   * @example
   * ```ts
   * const stop = webext.storage.local.watch<string>('theme', (value, previous) => {
   *   console.log(previous, value)
   * })
   * stop()
   * ```
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/onChanged
   */
  watch<T>(
    key: string,
    listener: (value: T | undefined, previous: T | undefined) => void
  ): () => void
}
/**
 * ネイティブのStorageAreaに共通ヘルパーを追加した領域。
 *
 * @remarks
 * 継承する `get(keys)` は値の辞書を取得し、省略・`null` は全件、既定値の辞書も指定できます。
 * `set(items)` はキーと値の辞書を保存、`remove(keys)` は指定キーを削除、`clear()` は全件削除します。
 * これらはネイティブのPromiseを返し、失敗は拒否として伝播します。managedへの変更操作は拒否されます。
 * `onChanged` は領域単位のネイティブイベントです。直接登録したリスナーは利用側で解除してください。
 * 共通ヘルパー以外のネイティブメソッド・イベントの対応状況やアクセス制限は補完しません。
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/get
 */
export type StorageArea = Omit<Browser.Storage.StorageArea, 'getBytesInUse'> &
  StorageHelpers & {
    /**
     * `{name}:{key}` 形式で保存する名前空間を選択します。
     * `name` は空文字・コロンを含む文字列を指定できません（同期的にTypeError）。
     * 戻り値の全メソッドは接頭辞なしのキーを受け取り、返すキーも接頭辞なしです。
     * 型引数Schemaでキーと値の対応を定義できます。実行時検証は行いません。
     * 元の領域やネイティブAPIの動作は変更しません。
     */
    namespace<Schema extends object | undefined = undefined>(
      name: string
    ): NamespacedStorageArea<Schema>
  }

/**
 * 名前空間内だけを読み書きするストレージ。
 *
 * @remarks
 * `get()` / `get(null)` はこの名前空間の全件、`clear()` はこの名前空間だけの削除です。
 * `getKeys()` は接頭辞を除いたキーを返し、`getBytesInUse()` は接頭辞を含む実保存キーで計測します。
 * 全件取得・削除・計測には領域全体のキー列挙または読み取りが必要です。
 * `clear()` は列挙後に追加されたキーの削除を保証しません。
 * `watch()` は元の領域と監視解除処理を共有します。ネイティブイベントは公開しません。
 * 名前空間はキーの整理用であり、権限・クォータ・アクセス制限を分離しません。
 */
export type NamespacedStorageArea<
  Schema extends object | undefined = undefined,
> = Schema extends object
  ? TypedStorageMethods<Schema> & Pick<StorageHelpers, 'capabilities'>
  : StorageHelpers &
      Pick<Browser.Storage.StorageArea, 'get' | 'set' | 'remove' | 'clear'>

type StorageKey<Schema> = Extract<keyof Schema, string>
type ExactStorageFields<Fields, Schema> = Fields & {
  [K in keyof Fields]: K extends StorageKey<Schema> ? Schema[K] : never
}
type StorageWithDefaults<Schema, Defaults> = {
  [K in keyof Defaults]: K extends keyof Schema
    ? Exclude<Schema[K], undefined> | Defaults[K]
    : never
}

/** スキーマはコンパイル時だけ利用します。保存値の検証・既定値保存・キーの除外は行いません。 */
interface TypedStorageMethods<Schema extends object> {
  /** 未保存のキーは辞書に含まれないため、全プロパティが任意です。 */
  get(keys?: null): Promise<Partial<Schema>>
  get<K extends StorageKey<Schema>>(
    keys: K | readonly K[]
  ): Promise<Partial<Pick<Schema, K>>>
  get<Defaults extends object>(
    defaults: ExactStorageFields<Defaults, Schema>
  ): Promise<StorageWithDefaults<Schema, Defaults>>
  set<Items extends object>(
    items: ExactStorageFields<Items, Schema>
  ): Promise<void>
  remove(
    keys: StorageKey<Schema> | readonly StorageKey<Schema>[]
  ): Promise<void>
  clear(): Promise<void>
  /** 実保存データにはスキーマ外のキーも存在し得るため、string[]を返します。 */
  getKeys(): Promise<string[]>
  getBytesInUse(
    keys?: StorageKey<Schema> | readonly StorageKey<Schema>[] | null
  ): Promise<number>
  getValue<K extends StorageKey<Schema>>(key: K): Promise<Schema[K] | undefined>
  getValue<
    K extends StorageKey<Schema>,
    Default extends NoInfer<Schema[K] | undefined>,
  >(
    key: K,
    defaultValue: Default
  ): Promise<Exclude<Schema[K], undefined> | Default>
  setValue<K extends StorageKey<Schema>>(
    key: K,
    value: NoInfer<Schema[K]>
  ): Promise<void>
  watch<K extends StorageKey<Schema>>(
    key: K,
    listener: (
      value: Schema[K] | undefined,
      previous: Schema[K] | undefined
    ) => void
  ): () => void
}
/**
 * 拡張機能のネイティブストレージと共通ヘルパー。
 *
 * @remarks `storage` 権限が必要です。領域の存在だけでは権限・アクセス設定・ポリシーの利用可否を保証しません。
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage
 */
export interface WebExtStorage {
  /**
   * 同じフレームのMAIN worldへ、指定した領域・名前空間だけを公開します。
   * コンテンツスクリプト専用。既定は読取専用で、ページも通信を観測・偽装できます。
   * 通信namespaceごとに1つ登録でき、解除関数・storage.disposeでも停止します。
   * ストレージ権限と実領域へのアクセス権限が必要で、backgroundへの代替中継は行いません。
   */
  bridgeMainWorld(options: MainWorldStorageBridgeOptions): () => void
  /** ローカルに永続保存する領域。保存量の制限はネイティブに従います。 */
  local: StorageArea
  /** ブラウザの同期設定に従って同期する領域。容量・書き込み頻度の制限はネイティブに従います。 */
  sync: StorageArea
  /**
   * 管理者などが構成する読み取り専用領域。`setValue()` やネイティブの変更操作は拒否されます。
   *
   * @remarks
   * Chromeはスキーマと企業ポリシー、Firefoxはネイティブマニフェストまたは `3rdparty` ポリシーなどで
   * 利用側が事前構成します。Firefoxでは未構成の領域の読み取りも失敗し得るため、空の辞書を前提にしないでください。
   * @see https://developer.chrome.com/docs/extensions/reference/api/storage
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/managed
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/get
   */
  managed: StorageArea
  /**
   * ブラウザが提供する、ディスクに永続保存しないメモリ上のsession領域。
   *
   * @remarks
   * 未対応なら `undefined`。service worker内のメモリやlocalなどの永続領域では代用しません。
   * 利用可否・寿命はブラウザと実行コンテキストに依存し、通常コンテンツスクリプトには公開されません。
   * 必要なネイティブのアクセス設定は利用側で行います。
   * @see https://developer.chrome.com/docs/extensions/reference/api/storage
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session
   */
  session?: StorageArea
  /**
   * 全領域のネイティブ変更イベント。値の重複排除は行いません。
   *
   * @remarks 直接登録したリスナーは `dispose()` の対象外です。利用側で `removeListener()` してください。
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/onChanged
   */
  onChanged: Browser.Storage.Static['onChanged']
  /**
   * このラッパーの `watch()` の監視とMAIN worldストレージ中継を解除します。
   *
   * @returns 戻り値はありません。
   * @remarks
   * 繰り返し呼べます。保存値・ネイティブ設定・直接登録されたリスナーは変更しません。
   * 終端的な破棄ではなく、その後も読み書きや新しい `watch()` の登録が可能です。
   */
  dispose(): void
}

/** ネイティブの補完対象メソッドを任意にした内部型。 @internal */
type NativeArea = Omit<
  Browser.Storage.StorageArea,
  'getKeys' | 'getBytesInUse'
> & {
  getKeys?(): Promise<string[]>
  getBytesInUse?(keys?: string | string[] | null): Promise<number>
}

/**
 * ネイティブAPIを変更せず、存在する領域にヘルパーを追加します。
 * @param storage - ラップするネイティブストレージAPI。
 * @returns 監視の解除処理を管理するストレージラッパー。
 * @internal
 */
export function createStorage(
  storage: Browser.Storage.Static,
  context?: string
): WebExtStorage {
  const areas: Record<string, StorageArea> = {}
  const disposers = createDisposables()
  const bridges = new Set<string>()
  for (const name of ['local', 'sync', 'managed', 'session'] as const) {
    const area = storage[name] as NativeArea | undefined
    if (!area) continue
    const capabilities = Object.freeze({
      getKeys: area.getKeys ? ('native' as const) : ('polyfilled' as const),
      getBytesInUse: area.getBytesInUse
        ? ('native' as const)
        : ('estimated' as const),
    })
    const helpers: StorageHelpers = {
      capabilities,
      async getKeys() {
        return area.getKeys ? area.getKeys() : Object.keys(await area.get(null))
      },
      async getBytesInUse(keys = null) {
        if (area.getBytesInUse) return area.getBytesInUse(keys)
        return estimateBytes(await area.get(keys))
      },
      async getValue<T>(key: string, defaultValue?: T): Promise<T> {
        const values = await area.get(key)
        return (Object.hasOwn(values, key) ? values[key] : defaultValue) as T
      },
      async setValue(key, value) {
        await area.set({ [key]: value })
      },
      watch<T>(
        key: string,
        listener: (value: T | undefined, previous: T | undefined) => void
      ) {
        if (!storage.onChanged)
          throw new UnsupportedOperationError('storage.watch')
        const onChanged = (
          changes: Record<string, Browser.Storage.StorageChange>,
          areaName: string
        ) => {
          if (areaName !== name || !Object.hasOwn(changes, key)) return
          const change = changes[key]!
          listener(
            change.newValue as T | undefined,
            change.oldValue as T | undefined
          )
        }
        storage.onChanged.addListener(onChanged)
        return disposers.add(() => storage.onChanged.removeListener(onChanged))
      },
    }
    const wrapped: StorageArea = facade(area, {
      ...helpers,
      namespace<Schema extends object | undefined = undefined>(
        namespace: string
      ): NamespacedStorageArea<Schema> {
        return createNamespace(
          wrapped,
          namespace
        ) as NamespacedStorageArea<Schema>
      },
    })
    areas[name] = wrapped
  }
  return facade(storage, {
    ...areas,
    bridgeMainWorld(options: MainWorldStorageBridgeOptions) {
      if (context !== 'content-script')
        throw new UnsupportedOperationError(
          'storage.bridgeMainWorld outside content-script'
        )
      if (bridges.has(options.namespace))
        throw new Error(
          'A MAIN world storage bridge is already registered for this namespace'
        )
      const namespace = options.namespace
      const stop = createStorageBridge(areas, storage, options)
      bridges.add(namespace)
      return disposers.add(() => {
        bridges.delete(namespace)
        stop()
      })
    },
    dispose() {
      disposers.dispose()
    },
  }) as unknown as WebExtStorage
}
