/// <reference types="chrome" />

import type Browser from 'webextension-polyfill'
import type { ContextOptions, WebExtContext } from './context'
import type { Messaging } from './messaging'
import type { PopoutOptions } from './popout'
import type { Side } from './side'
import type { WebExtStorage } from './storage'
import type { WebExtTabs } from './tabs'

import { createContext } from './context'
import { facade, lazyFacade } from './facade'
import { createMessaging } from './messaging'
import { normalizeExtensionPath } from './paths'
import { createPopout } from './popout'
import { createSide } from './side'
import { createStorage } from './storage'
import { createTabs } from './tabs'

export type { WebExtContext } from './context'
export type { WebExtTabs } from './tabs'

type NativeApi = Browser.Browser & {
  sidePanel?: typeof chrome.sidePanel
}

/**
 * 共通APIインスタンスの作成設定。省略した値はネイティブAPIと実行環境から取得します。
 *
 * @remarks
 * ブラウザAPIのアクセス権限を付与したり、ネイティブAPI全体をPromise化したりする設定ではありません。
 * 環境判定の上書きは継承した `context`・`browser`・`url` で指定します。
 * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getManifest
 */
export interface CreateWebExtOptions extends ContextOptions {
  /**
   * 利用するネイティブAPI。テストでは互換のモックを注入できます。
   *
   * @remarks
   * 省略時は `runtime.id` があるグローバルの `browser` を優先し、なければ `chrome` を使います。
   * ライブラリからこのオブジェクトやグローバルのAPIを変更しません。
   */
  api?: typeof chrome | Browser.Browser
}

/**
 * Chrome / FirefoxのネイティブAPIに、共通操作と実用ヘルパーを追加したライブラリの公開API。
 *
 * @remarks
 * Manifest V3とPromise版のネイティブAPIがある環境を対象にします。
 * APIの利用可否はブラウザ・権限・manifest・実行コンテキストに依存し、未対応の
 * ネイティブAPI全体を補完するものではありません。独自ヘルパーの仕様は各メンバーを参照してください。
 * @see https://developer.chrome.com/docs/extensions/reference/api
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API
 */
export type WebExt = Omit<
  Browser.Browser,
  'tabs' | 'action' | 'storage' | 'menus' | 'sidebarAction'
> & {
  /** ブラウザ固有APIへのアクセス用の元のAPIオブジェクト。ライブラリからは変更しません。 */
  readonly native: typeof chrome | Browser.Browser
  /** 初期化時の実行環境とポップアウトの関連付け情報。作成後の変更には追従しません。 */
  readonly context: WebExtContext
  /** サイドパネルの共通操作。ネイティブのsidePanel / sidebarActionとは別の独自APIです。 */
  readonly side: Side
  /** 同じ拡張内の型付き要求・応答チャンネルを管理する独自API。 */
  readonly messaging: Messaging
  /** ネイティブのtabs APIと、コンテンツスクリプトでも使える共通タブ取得ヘルパー。 */
  readonly tabs: WebExtTabs
  /** ネイティブの各ストレージ領域と、値取得・変更監視などの共通ヘルパー。`storage` 権限が必要です。 */
  readonly storage: WebExtStorage
  /**
   * Firefoxの `menus`、またはChromeの `contextMenus` をネイティブのまま公開します。
   * @remarks 利用するブラウザのメニュー権限が必要です。ネイティブのcallback専用メソッドはPromise化しません。
   * @see https://developer.chrome.com/docs/extensions/reference/api/contextMenus
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus
   */
  readonly menus: Browser.ContextMenus.Static
  /**
   * 存在する場合のみ公開するChromeのネイティブsidePanel API。共通操作には `side` を使用します。
   * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel
   */
  readonly sidePanel?: typeof chrome.sidePanel
  /**
   * 存在する場合のみ公開するFirefoxのネイティブsidebarAction API。共通操作には `side` を使用します。
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction
   */
  readonly sidebarAction?: Browser.SidebarAction.Static
  /**
   * ネイティブaction APIと、popupページを別ウィンドウで開く独自ヘルパー。
   * @remarks manifestのaction設定や、利用可能な実行コンテキストが必要です。
   * @see https://developer.chrome.com/docs/extensions/reference/api/action
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/action
   */
  readonly action: Browser.Action.Static & {
    /**
     * 対象タブに現在設定されているactionのpopupページを別ウィンドウで開きます。
     *
     * @param options - 関連付けるタブとウィンドウの設定。省略した `tabId` は `tabs.getTargetId()`、`null` は関連付けなし。
     * @returns ネイティブの `windows.create()` が返すウィンドウ情報、または `undefined`。
     * @remarks
     * 既存タブは移動しません。URLのクエリとハッシュを保持します。
     * popupが空に設定されている場合は、manifestの初期値へ戻さずエラーにします。
     * @throws {TypeError} タブIDや取得したページのパスが不正な場合。Promiseの拒否として伝播します。
     * @throws {Error} popup未設定、対象解決やネイティブAPIの失敗。ウィンドウAPI未対応時は `UnsupportedOperationError`。
     * @see https://developer.chrome.com/docs/extensions/reference/api/action#method-getPopup
     * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/action/getPopup
     * @see https://developer.chrome.com/docs/extensions/reference/api/windows#method-create
     */
    openPopout(
      options?: PopoutOptions
    ): Promise<Browser.Windows.Window | undefined>
  }
  /**
   * background側の内部タブ取得ブリッジを同期的に登録します。
   *
   * @remarks
   * backgroundのトップレベルで呼んでください。service workerの起動ごとに同期登録される必要があります。
   * `createWebExt()` は作成時にもこの処理を呼びます。遅延初期化される `webext` では、
   * トップレベルの `webext.initialize()` により初期化と登録をその場で行えます。
   * 複数回呼んでも登録は増えず、background以外では何もしません。
   * @throws {UnsupportedOperationError} backgroundでネイティブのtabs APIが利用できない場合。同期例外です。
   * @see https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events
   */
  initialize(): void
  /**
   * このインスタンスのメッセージ受信、storage.watch、actionクリック連携を解除します。
   *
   * @remarks
   * 繰り返し呼べます。保存値・パネル・ネイティブ設定・直接登録されたリスナーは変更しません。
   * 送信済みの待機や実行中の受信処理はキャンセルしません。
   * メッセージングは終端的に破棄されるため、再利用には `createWebExt()` で新しいインスタンスを作成してください。
   */
  dispose(): void
}

function currentApi() {
  return globalThis.browser?.runtime?.id
    ? globalThis.browser
    : globalThis.chrome
}

/**
 * ネイティブAPIを変更せず、独立した共通APIのインスタンスを作成します。
 *
 * @param options - APIの注入と実行環境の上書き設定。
 * @returns 実行環境・共通ヘルパー・解除処理を持つインスタンス。
 * @remarks
 * backgroundとして作成する場合、内部タブ取得ブリッジはこの呼び出し中に同期登録されます。
 * 権限取得、manifestの変換、ネイティブAPI全体のPromise化は行いません。
 * @throws {Error} 拡張APIがない場合や、初期化に必要なネイティブAPIが失敗した場合。同期例外です。
 * @throws {TypeError} 上書きURLなどをURLとして解析できない場合。同期例外です。
 * @example
 * ```ts
 * const webext = createWebExt({ context: 'sidepanel' })
 * const tab = await webext.tabs.getTarget()
 * ```
 * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getURL
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events
 */
export function createWebExt(options: CreateWebExtOptions = {}): WebExt {
  const native = options.api ?? currentApi()
  const api = native as unknown as NativeApi | undefined
  if (!api?.runtime?.getManifest)
    throw new Error('webext requires a WebExtension context or an injected API')

  const extensionUrl = new URL(api.runtime.getURL('/'))
  const context = createContext(api, extensionUrl, options)
  const messaging = createMessaging(api)
  const { tabs, initialize } = createTabs(api, context, messaging)
  const { resolveTabId, openPopout } = createPopout(api, extensionUrl, () =>
    tabs.getTargetId()
  )
  const action =
    api.action &&
    facade(api.action, {
      async openPopout(options: PopoutOptions = {}) {
        const tabId = await resolveTabId(options)
        // 空のパスはpopupが明示的に無効化されていることを示す。
        const path = await api.action.getPopup(tabId === null ? {} : { tabId })
        if (!path) throw new Error('No action popup path is configured')
        return openPopout(path, { ...options, tabId })
      },
    })
  const side = createSide(api, {
    resolveTabId,
    normalizePath: (path) => normalizeExtensionPath(path, extensionUrl),
    openPopout,
  })
  const storage = api.storage && createStorage(api.storage)
  const instance = facade(api, {
    native,
    context,
    tabs,
    action,
    side,
    storage,
    menus: api.menus ?? api.contextMenus,
    messaging,
    initialize,
    dispose() {
      side.dispose()
      storage?.dispose()
      messaging.dispose()
    },
  }) as unknown as WebExt
  initialize()
  return instance
}

/**
 * 初回のプロパティアクセスで初期化する、既定の共通APIインスタンス。
 *
 * @remarks
 * モジュールのインポートだけでは拡張APIへアクセスしません。プロパティの読み取りや列挙などは
 * 初期化を発生させるため、拡張環境が必要です。backgroundのトップレベルでは
 * `webext.initialize()` を同期的に呼び、内部ブリッジを登録してください。
 * 設定の注入や破棄後の新しいインスタンスには {@link createWebExt} を使用します。
 * @example
 * ```ts
 * import { webext } from '@midra/webext'
 * webext.initialize()
 * ```
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events
 */
export const webext = lazyFacade(() => createWebExt())
