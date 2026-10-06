import type Browser from 'webextension-polyfill'

import { UnsupportedOperationError, assertTabId } from './errors'
import { LINKED_TAB_ID_NAME, POPOUT_NAME, resolveExtensionPath } from './paths'

/**
 * actionのpopupやサイドパネルの拡張ページを別ウィンドウで開くためのライブラリ独自設定。
 *
 * @remarks
 * ウィンドウの種類は `popup`、URLは対象ページから生成する。
 * `tabId` 以外の値は `windows.create` にそのまま渡し、省略値もブラウザの既定に従う。
 * 寸法・位置・状態の組み合わせやプライベートウィンドウの制約はネイティブ側で検証され、エラーは伝播する。
 * @example
 * ```ts
 * await webext.side.openPopout({ tabId: null, width: 420, height: 720 })
 * ```
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#method-create
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create
 */
export interface PopoutOptions {
  /**
   * 関連付けるタブの非負の安全な整数ID。既存タブは移動しない。
   *
   * @remarks
   * 省略時は `tabs.getTargetId()` の対象を使う。`null` または対象がない場合は関連付けなし。
   * URLの内部クエリに記録する独自の関連付けであり、認証・アクセス制御には使わない。
   * タブを移動するネイティブの `windows.create` の `tabId` には渡さない。
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create#parameters
   */
  tabId?: number | null
  /** フレームを含むウィンドウ幅（ピクセル）。省略時はブラウザが決定する。`state` の併用制約に注意。 */
  width?: number
  /** フレームを含むウィンドウ高さ（ピクセル）。省略時はブラウザが決定する。`state` の併用制約に注意。 */
  height?: number
  /** 画面左端からの位置（ピクセル）。省略時はブラウザが決定する。`state` の併用制約に注意。 */
  left?: number
  /** 画面上端からの位置（ピクセル）。省略時はブラウザが決定する。`state` の併用制約に注意。 */
  top?: number
  /** `true` ならフォーカスして開き、`false` なら非アクティブで開く。省略時はネイティブの既定に従う。 */
  focused?: boolean
  /**
   * シークレット／プライベートウィンドウとして開くか。
   *
   * @remarks
   * 拡張機能のプライベート利用許可やブラウザの制約により、ネイティブ側で拒否される場合がある。
   * 利用許可の取得や別のウィンドウへのフォールバックは行わない。
   */
  incognito?: boolean
  /**
   * 作成時のウィンドウ状態。
   *
   * @remarks `minimized`・`maximized`・`fullscreen` は `left`・`top`・`width`・`height` と併用できない。
   * @see https://developer.chrome.com/docs/extensions/reference/api/windows#method-create
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create#parameters
   */
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen'
}

export function createPopout(
  api: { windows?: Pick<Browser.Windows.Static, 'create'> },
  extensionUrl: URL,
  getTargetId: () => Promise<number | undefined>
) {
  async function resolveTabId(options: PopoutOptions): Promise<number | null> {
    if (options.tabId === null) return null
    if (options.tabId !== undefined) {
      assertTabId(options.tabId)
      return options.tabId
    }
    return (await getTargetId()) ?? null
  }

  async function openPopout(path: string, options: PopoutOptions = {}) {
    if (!api.windows) throw new UnsupportedOperationError('popout windows')
    // 検証とURL生成を一度に行い、同じパスを再解析しない。
    const target = resolveExtensionPath(path, extensionUrl)
    const { tabId: _requestedTabId, ...createData } = options
    const tabId = await resolveTabId(options)
    target.searchParams.set(POPOUT_NAME, '1')
    target.searchParams.delete(LINKED_TAB_ID_NAME)
    if (tabId !== null)
      target.searchParams.set(LINKED_TAB_ID_NAME, String(tabId))
    return api.windows.create({
      ...createData,
      type: 'popup',
      url: target.href,
    })
  }

  return { resolveTabId, openPopout }
}
