import type Browser from 'webextension-polyfill'
import type { PopoutOptions } from './popout'

import { createDisposables } from './disposables'
import { UnsupportedOperationError, assertTabId } from './errors'

export type { PopoutOptions } from './popout'

export { UnsupportedOperationError } from './errors'

const WINDOW_ID_CURRENT = -2

/**
 * サイドパネルの開閉対象。
 *
 * @remarks
 * 対象省略時は現在のウィンドウ。ChromeではネイティブAPIへ対象を渡す。
 * Firefoxの開閉は対象指定に対応せず、省略または `windowId: -2` のみ受け付ける。
 * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-OpenOptions
 * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-CloseOptions
 */
export interface SideTarget {
  /** 対象タブの非負の安全な整数ID。Firefoxの開閉では指定不可。 */
  tabId?: number
  /** 対象ウィンドウの非負の安全な整数ID。`-2` は現在のウィンドウを表す。 */
  windowId?: number
}
/**
 * サイドパネルのパス設定を取得・変更する対象。ウィンドウ単位の指定は提供しない。
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-GetPanelOptions
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/setPanel
 */
export interface SidePathTarget {
  /** 対象タブの非負の安全な整数ID。省略時はグローバル（既定）の設定を扱う。 */
  tabId?: number
}

/**
 * 初期化時に検出したサイドパネル関連APIの対応状況。
 *
 * @remarks
 * APIの存在に基づく判定であり、権限・manifest設定・バージョン要件や操作の成功は保証しない。
 */
export interface SideCapabilities {
  /** パネルを開くAPIがあるか。 */
  readonly open: boolean
  /** パネルを閉じるAPIがあるか。ChromeのネイティブAPIは141以降。 */
  readonly close: boolean
  /** パス設定の取得・変更に必要なAPIがあるか。 */
  readonly path: boolean
  /**
   * 開状態の判定方式。`false` は未対応。
   *
   * @remarks
   * `native` はFirefoxの表示状態取得、`document` はChromeのパネルドキュメントの存在観測。
   * 後者は切り替え・終了途中などの厳密なUI表示状態と一致しない可能性がある。
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/isOpen
   * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts
   */
  readonly isOpen: 'native' | 'document' | false
  /** 明示的なタブ・ウィンドウを指定して開くAPIがあるか。閉じる操作の対応状況ではない。 */
  readonly targetedOpen: boolean
  /** actionクリックイベントとパネルを開くAPIがあり、クリック連携を登録できるか。 */
  readonly actionClick: boolean
}
/**
 * ChromeのsidePanelとFirefoxのsidebarActionを共通の操作として扱うライブラリ独自API。
 *
 * @remarks
 * ネイティブAPIの完全な模倣ではなく、パスの統一やポップアウトなどの補助操作を提供する。
 * 非同期操作の検証エラー・未対応エラー・ネイティブAPIのエラーはPromiseの拒否として伝播する。
 * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open
 */
export interface Side {
  /** 開くAPIがあるか。表示中かどうかや、権限・manifest設定の正しさを示すものではない。 */
  readonly available: boolean
  /** APIの存在から検出した機能別の対応状況。 */
  readonly capabilities: SideCapabilities
  /**
   * 拡張機能のサイドパネルを開く。
   *
   * @param target - 開く対象。省略時、Chromeは現在のウィンドウのグローバルパネルを開く。
   * @returns 開く処理が完了すると値なしで解決するPromise。
   * @remarks
   * 両ブラウザでユーザー操作のハンドラーから直接呼ぶ。Chromeの `sidePanel.open` は116以降。
   * Chromeで `tabId` を指定するとタブ固有パネルを使い、未設定ならグローバルパネルを使う。
   * `windowId` のみではタブ固有パネルを選ばない。Firefoxはアクティブなウィンドウで開く。
   * 省略時はChromeへ `windowId: -2` を同期的に渡すため、この定数に未対応の環境では実際のIDを指定する。
   * @throws {@link UnsupportedOperationError} 開くAPIがない場合、またはFirefoxで明示的な対象を指定した場合。
   * @throws {TypeError} タブ・ウィンドウIDが不正な場合。
   * @example
   * ```ts
   * button.addEventListener('click', () => {
   *   void webext.side.open().catch(console.error)
   * })
   * ```
   * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-open
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open
   */
  open(target?: SideTarget): Promise<void>
  /**
   * 拡張機能のサイドパネルを閉じる。無効化やパス設定の変更は行わない。
   *
   * @param target - 閉じる対象。省略時は現在のウィンドウ（Chromeではグローバルパネル）。
   * @returns 閉じる処理が完了すると値なしで解決するPromise。
   * @remarks
   * Chromeの `sidePanel.close` は141以降。現在のウィンドウ指定は実際のIDを取得してから渡す。
   * タブ指定時の動作はネイティブに従い、Chrome 145以降はグローバルパネルしか開いていないと拒否される。
   * Firefoxはアクティブなウィンドウで閉じる。MDNの制約に従いユーザー操作のハンドラーから呼ぶ。
   * @throws {@link UnsupportedOperationError} 閉じるためのAPIがない場合、またはFirefoxで明示的な対象を指定した場合。
   * @throws {TypeError} タブ・ウィンドウIDが不正な場合。
   * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-close
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/close
   */
  close(target?: SideTarget): Promise<void>
  /**
   * 設定中のパネルのパスを拡張ルート相対形式で取得する。
   *
   * @param target - 設定の取得対象。省略時はグローバル（既定）の設定。
   * @returns クエリ・ハッシュを保持したパス。パスが未設定または空なら `undefined`。
   * @throws {@link UnsupportedOperationError} パスを取得するAPIがない場合。
   * @throws {TypeError} タブIDが不正、または取得したパスが同じ拡張内を指さない場合。
   * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-getOptions
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/getPanel
   */
  getPath(target?: SidePathTarget): Promise<string | undefined>
  /**
   * パネルに使用する拡張ページのパスを変更する。
   *
   * @param path - 拡張ルート相対パス、または同じ拡張内の絶対URL。クエリ・ハッシュを保持する。
   * @param target - 設定の変更対象。省略時はグローバル（既定）の設定。
   * @returns パス設定の変更が完了すると値なしで解決するPromise。
   * @remarks パネルを開く操作ではない。FirefoxのネイティブAPIと異なり、外部URLや空文字列による設定解除は受け付けない。
   * @throws {@link UnsupportedOperationError} パスを変更するAPIがない場合。
   * @throws {TypeError} タブIDやパスが不正、空のパス、または外部URLを指定した場合。
   * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-setOptions
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/setPanel
   */
  setPath(path: string, target?: SidePathTarget): Promise<void>
  /**
   * 指定ウィンドウでパネルが開いているかを判定する。
   *
   * @param target - 判定対象。
   * @param target.windowId - ウィンドウID。省略または `-2` は現在のウィンドウ（Firefoxでは最前面）。
   * @returns Firefoxではネイティブの表示状態、Chromeでは対象ウィンドウの `SIDE_PANEL` コンテキストが存在するか。
   * @remarks
   * Firefoxでは開閉と異なり明示的なウィンドウIDを指定できる。
   * Chromeは `runtime.getContexts` によるドキュメントの存在観測であり、厳密なUI表示状態を保証しない。
   * @throws {@link UnsupportedOperationError} 状態判定に必要なAPIがない場合。
   * @throws {TypeError} ウィンドウIDが不正な場合。
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/isOpen
   * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts
   */
  isOpen(target?: { windowId?: number }): Promise<boolean>
  /**
   * 対象タブに設定中のパネルページを別ウィンドウで開くライブラリ独自ヘルパー。
   *
   * @param options - 関連付けるタブとウィンドウの設定。`tabId: null` は関連付けなしでグローバルのパスを使う。
   * @returns ネイティブの `windows.create` が返すウィンドウ情報、または `undefined`。
   * @remarks
   * `tabId` 省略時は `tabs.getTargetId()` の対象を使い、対象がなければグローバルのパスを使う。
   * 既存タブの移動やサイドパネルの開閉は行わない。寸法・状態・プライベート設定の制約は {@link PopoutOptions} を参照。
   * @throws {@link UnsupportedOperationError} パス取得やウィンドウ作成に必要なAPIがない場合。
   * @throws {TypeError} タブIDやパスが不正な場合。
   * @throws {Error} パネルのパスが未設定の場合。対象解決・設定取得・ウィンドウ作成のエラーも伝播する。
   * @example
   * ```ts
   * await webext.side.openPopout({ tabId: null, width: 420, height: 720 })
   * ```
   * @see https://developer.chrome.com/docs/extensions/reference/api/windows#method-create
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create
   */
  openPopout(
    options?: PopoutOptions
  ): Promise<Browser.Windows.Window | undefined>
  /**
   * actionクリックでパネルを開くリスナーを登録するライブラリ独自ヘルパー。
   *
   * @param onError - パネルを開くPromiseが拒否されたときに呼ぶエラーハンドラー。
   * @returns この登録を解除する関数。繰り返し呼んでもよい。
   * @remarks
   * background起動時のトップレベルで同期的に登録する。actionのpopupが設定されているタブではクリックイベントが発火しない。
   * Chromeではクリックしたタブのウィンドウのグローバルパネルを開き、Firefoxではアクティブなウィンドウで開く。
   * ネイティブの `setPanelBehavior` を設定するものではなく、クリック時に `open` を呼ぶ。
   * @throws {@link UnsupportedOperationError} クリックイベントまたはパネルを開くAPIがない場合。
   * @example
   * ```ts
   * const unbind = webext.side.bindActionClick(console.error)
   * ```
   * @see https://developer.chrome.com/docs/extensions/reference/api/action#event-onClicked
   */
  bindActionClick(onError: (error: unknown) => void): () => void
  /** このインスタンスが登録したactionクリックのリスナーをすべて解除する。パネルは閉じない。繰り返し呼んでもよい。 */
  dispose(): void
}

export interface SideNativeApi {
  sidePanel?: {
    open?(options: SideTarget): Promise<void>
    close?(options: SideTarget): Promise<void>
    getOptions?(options: SidePathTarget): Promise<{ path?: string }>
    setOptions?(options: SidePathTarget & { path: string }): Promise<void>
  }
  sidebarAction?: {
    open(): Promise<void>
    close(): Promise<void>
    getPanel(options: SidePathTarget): Promise<string>
    setPanel(options: SidePathTarget & { panel: string }): Promise<void>
    isOpen?(options: { windowId?: number }): Promise<boolean>
  }
  runtime?: {
    getContexts?(filter: {
      contextTypes: 'SIDE_PANEL'[]
      windowIds?: number[]
    }): Promise<{ windowId: number }[]>
  }
  windows?: { getCurrent(): Promise<{ id?: number }> }
  action?: { onClicked: Browser.Action.Static['onClicked'] }
}

export function createSide(
  api: SideNativeApi,
  helpers: {
    resolveTabId(options: PopoutOptions): Promise<number | null>
    normalizePath(path: string): string
    openPopout(
      path: string,
      options?: PopoutOptions
    ): Promise<Browser.Windows.Window | undefined>
  }
): Side {
  const panel = api.sidePanel
  const sidebar = panel ? undefined : api.sidebarAction
  const disposers = createDisposables()
  const capabilities = Object.freeze({
    open: !!(panel?.open || sidebar?.open),
    close: !!(panel?.close || sidebar?.close),
    path: !!((panel?.getOptions && panel.setOptions) || sidebar),
    isOpen: sidebar?.isOpen
      ? ('native' as const)
      : panel && api.runtime?.getContexts && api.windows?.getCurrent
        ? ('document' as const)
        : (false as const),
    targetedOpen: !!panel?.open,
    actionClick: !!api.action?.onClicked && !!(panel?.open || sidebar?.open),
  })
  function validateTarget(target: SideTarget) {
    if (target.tabId !== undefined) assertTabId(target.tabId)
    if (
      target.windowId !== undefined &&
      (!Number.isSafeInteger(target.windowId) ||
        (target.windowId < 0 && target.windowId !== WINDOW_ID_CURRENT))
    ) {
      throw new TypeError('Invalid window ID')
    }
  }
  function requireCurrentWindow(target: SideTarget) {
    if (
      target.tabId !== undefined ||
      (target.windowId !== undefined && target.windowId !== WINDOW_ID_CURRENT)
    ) {
      throw new UnsupportedOperationError('side explicit open/close target')
    }
  }
  function chromeTarget(target: SideTarget): SideTarget {
    return target.tabId !== undefined || target.windowId !== undefined
      ? { ...target }
      : { windowId: WINDOW_ID_CURRENT }
  }
  async function getPath(target: SidePathTarget = {}) {
    validateTarget(target)
    const path = panel?.getOptions
      ? (await panel.getOptions({ ...target })).path
      : sidebar
        ? await sidebar.getPanel({ ...target })
        : undefined
    if (!panel?.getOptions && !sidebar)
      throw new UnsupportedOperationError('side.getPath')
    return path ? helpers.normalizePath(path) : undefined
  }
  const side: Side = {
    available: capabilities.open,
    capabilities,
    async open(target = {}) {
      validateTarget(target)
      // ユーザー操作の有効期間を保つため、ネイティブ呼び出し前にawaitしない。
      if (panel?.open) return panel.open(chromeTarget(target))
      if (sidebar) {
        requireCurrentWindow(target)
        return sidebar.open()
      }
      throw new UnsupportedOperationError('side.open')
    },
    async close(target = {}) {
      validateTarget(target)
      if (panel?.close) {
        const options = chromeTarget(target)
        // close()は現在のウィンドウ定数を解決しない環境がある。
        // ユーザー操作は不要なので、実際のIDを非同期に取得してから閉じる。
        if (options.windowId === WINDOW_ID_CURRENT) {
          if (!api.windows?.getCurrent)
            throw new UnsupportedOperationError('side.close current window')
          const windowId = (await api.windows.getCurrent()).id
          if (windowId === undefined)
            throw new Error('No current window is available')
          options.windowId = windowId
        }
        return panel.close(options)
      }
      if (sidebar) {
        requireCurrentWindow(target)
        return sidebar.close()
      }
      throw new UnsupportedOperationError('side.close')
    },
    getPath,
    async setPath(path, target = {}) {
      validateTarget(target)
      const normalized = helpers.normalizePath(path)
      if (panel?.setOptions)
        return panel.setOptions({ ...target, path: normalized })
      if (sidebar)
        return sidebar.setPanel({ ...target, panel: `/${normalized}` })
      throw new UnsupportedOperationError('side.setPath')
    },
    async isOpen(target = {}) {
      validateTarget(target)
      if (sidebar?.isOpen) return sidebar.isOpen({ ...target })
      if (panel && api.runtime?.getContexts && api.windows?.getCurrent) {
        const windowId =
          target.windowId === undefined || target.windowId === WINDOW_ID_CURRENT
            ? (await api.windows.getCurrent()).id
            : target.windowId
        if (windowId === undefined) return false
        const contexts = await api.runtime.getContexts({
          contextTypes: ['SIDE_PANEL'],
          windowIds: [windowId],
        })
        return contexts.length > 0
      }
      throw new UnsupportedOperationError('side.isOpen')
    },
    async openPopout(options = {}) {
      const tabId = await helpers.resolveTabId(options)
      const path = await getPath(tabId == null ? {} : { tabId })
      if (!path) throw new Error('No side panel path is configured')
      return helpers.openPopout(path, { ...options, tabId })
    },
    bindActionClick(onError) {
      if (!capabilities.actionClick)
        throw new UnsupportedOperationError('side.bindActionClick')
      const listener = (tab: Browser.Tabs.Tab) => {
        void side
          .open(
            panel && tab.windowId !== undefined
              ? { windowId: tab.windowId }
              : {}
          )
          .catch(onError)
      }
      api.action!.onClicked.addListener(listener)
      return disposers.add(() => api.action!.onClicked.removeListener(listener))
    },
    dispose() {
      disposers.dispose()
    },
  }
  return side
}
