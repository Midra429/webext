import type Browser from 'webextension-polyfill'
import type { UnsupportedOperationError } from '../errors'
import type { PopoutOptions } from '../popout'

/**
 * サイドパネルの開閉対象。
 *
 * @remarks
 * 対象省略時は現在のウィンドウ。ChromeではネイティブAPIへ対象を渡す。
 * Firefoxのopenは対象指定に未対応。closeは初期化済みのパネルへ中継して対象指定を補完する。
 * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-OpenOptions
 * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-CloseOptions
 */
export interface SideTarget {
  /** 対象タブの非負の安全な整数ID。Firefoxのopenでは指定不可。 */
  tabId?: number
  /** 対象ウィンドウの非負の安全な整数ID。`-2` は現在のウィンドウを表す。 */
  windowId?: number
}
/**
 * サイドパネルのパス設定を取得・変更する対象。タブとウィンドウの同時指定は不可。
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-GetPanelOptions
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/setPanel
 */
export interface SidePathTarget {
  /** 対象タブ。取得時はタブ > ウィンドウ > グローバルの順で解決する。 */
  tabId?: number
  /** 対象ウィンドウ。`-2` は現在のウィンドウ。両ID省略時はグローバル設定。 */
  windowId?: number
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
  /** ウィンドウ別のパス設定。Chromeはbackgroundの初期化とstorage権限が必要。 */
  readonly windowPath: boolean
  /** ユーザー操作なしで閉じる方式。Firefoxは133+とパネル側の初期化が必要。 */
  readonly backgroundClose: 'native' | 'document' | false
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
   * @param target - 閉じる対象。省略時は現在のウィンドウ。ウィンドウ指定はその中のタブ固有パネルも閉じる。
   * @returns 閉じる処理が完了すると値なしで解決するPromise。
   * @remarks
   * Chromeの `sidePanel.close` は141以降。現在のウィンドウ指定は実際のIDを取得してから渡す。
   * タブ固有設定がなければ、そのウィンドウのグローバルパネルを閉じる。
   * Firefox 133+はパネル側でも初期化し、ユーザー操作なしで自身を閉じるよう依頼する。
   * Firefoxの非アクティブタブ指定は何もしない。ブリッジが利用できない場合のみ、ユーザー操作を要するネイティブcloseへフォールバックする。
   * @throws {@link UnsupportedOperationError} 閉じるAPIがない場合、またはFirefoxのブリッジなしで明示的な対象を指定した場合。
   * @throws {Error} Firefoxの表示中パネルが未初期化、または実際に閉じられなかった場合。
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
   * @remarks
   * パネルを開く操作ではない。タブ > ウィンドウ > グローバルの優先順位で切り替わる。
   * Chromeのウィンドウ別パスはstorage.sessionに保存し、backgroundでタブ別設定へ反映する。
   * 外部URLや空文字列による設定解除は受け付けない。
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
   * @param target.tabId - タブID。非アクティブタブはfalse。対象タブまたはグローバルのパネルを調べる。
   * @returns Firefoxではネイティブの表示状態、Chromeでは対象ウィンドウの `SIDE_PANEL` コンテキストが存在するか。
   * @remarks
   * Firefoxでは開閉と異なり明示的なウィンドウIDを指定できる。
   * Chromeは `runtime.getContexts` によるドキュメントの存在観測であり、厳密なUI表示状態を保証しない。
   * @throws {@link UnsupportedOperationError} 状態判定に必要なAPIがない場合。
   * @throws {TypeError} ウィンドウIDが不正な場合。
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/isOpen
   * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts
   */
  isOpen(target?: SideTarget): Promise<boolean>
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
   * Chromeではクリックしたタブを対象に開き、Firefoxではアクティブなウィンドウで開く。
   * ネイティブの `setPanelBehavior` を設定するものではなく、クリック時に `open` を呼ぶ。
   * @throws {@link UnsupportedOperationError} クリックイベントまたはパネルを開くAPIがない場合。
   * @example
   * ```ts
   * const unbind = webext.side.bindActionClick(console.error)
   * ```
   * @see https://developer.chrome.com/docs/extensions/reference/api/action#event-onClicked
   */
  bindActionClick(onError: (error: unknown) => void): () => void
  /** このインスタンスのactionクリック・関連付け監視・クローズ受信を解除する。パネルや保存値は変更しない。 */
  dispose(): void
}
