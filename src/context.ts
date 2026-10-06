import type Browser from 'webextension-polyfill'

import { LINKED_TAB_ID_NAME, POPOUT_NAME, isExtensionUrl } from './paths'

// DOMの型定義に含まれないservice workerの実行環境を判定する。
declare class ServiceWorkerGlobalScope {}

/**
 * インスタンス作成時に取得・推測した実行環境と、ポップアウトの関連付け情報。
 *
 * @remarks
 * このオブジェクトは凍結され、作成後のURLやmanifest設定の変更には追従しません。
 * ポップアウト関連の情報は拡張ページのクエリから取得する便宜上の情報であり、
 * 認証・アクセス制御や、関連付け先タブが現在も存在することの保証には使えません。
 * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getURL
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/getURL
 */
export interface WebExtContext {
  /** 関連付け先タブIDを格納する内部クエリの名前（`_webext_linked_tab_id`）。 */
  readonly LINKED_TAB_ID_NAME: string
  /** 拡張URLのスキームから判定するブラウザ種別。Chromium系は `chrome`。明示指定があればそちらを優先します。 */
  readonly browser: 'chrome' | 'firefox' | 'unknown'
  /** 実行コンテキストの役割。manifestや実行環境から判定できない場合は `null`。 */
  readonly type: 'background' | 'content-script' | 'popup' | 'sidepanel' | null
  /** 拡張ページの内部クエリに指定された非負の安全な整数ID。未指定・不正・通常のWebページでは `null`。 */
  readonly linkedTabId: number | null
  /** 拡張ページにポップアウト用の内部クエリがあるか。関連付け先がなくても `true` になり得ます。 */
  readonly isPopout: boolean
}

/** `CreateWebExtOptions` に含まれる実行環境の上書き設定。 */
export interface ContextOptions {
  /**
   * 実行コンテキストの役割を明示します。省略時だけ自動判定し、`null` は判定しない指定です。
   *
   * @remarks 動的に変更したpopup・パネルのパスや独自の拡張ページでは、役割を明示してください。
   */
  context?: WebExtContext['type']
  /** ブラウザ種別を明示します。APIを切り替えたり、未対応機能を有効化したりする設定ではありません。 */
  browser?: WebExtContext['browser']
  /**
   * 環境判定と内部クエリの取得に使う絶対URL。省略時は `globalThis.location?.href`。
   *
   * @remarks テストなどで使う上書き値です。ページ遷移や権限の付与は行いません。
   */
  url?: string
}

type Manifest = Browser.Manifest.WebExtensionManifest & {
  side_panel?: { default_path?: string }
}

function detectContext(
  api: Pick<Browser.Browser, 'runtime' | 'extension'>,
  url: URL | undefined,
  extensionPage: boolean,
  extensionUrl: URL
): WebExtContext['type'] {
  if (
    typeof ServiceWorkerGlobalScope !== 'undefined' &&
    globalThis instanceof ServiceWorkerGlobalScope
  )
    return 'background'
  if (
    typeof window !== 'undefined' &&
    api.extension?.getBackgroundPage?.() === window
  )
    return 'background'
  if (url && !extensionPage) return 'content-script'
  if (!extensionPage) return null

  const manifest = api.runtime.getManifest() as Manifest
  const matches = (path?: string) =>
    !!path && url?.pathname === new URL(path, extensionUrl).pathname
  if (matches(manifest.action?.default_popup)) return 'popup'
  if (
    matches(
      manifest.side_panel?.default_path ??
        manifest.sidebar_action?.default_panel
    )
  )
    return 'sidepanel'
  return null
}

export function createContext(
  api: Pick<Browser.Browser, 'runtime' | 'extension'>,
  extensionUrl: URL,
  options: ContextOptions
): WebExtContext {
  const href = options.url ?? globalThis.location?.href
  const url = href ? new URL(href) : undefined
  const extensionPage = !!url && isExtensionUrl(url, extensionUrl)
  // 通常のWebページが付けたクエリをリンク先やポップアウトの情報として信用しない。
  const rawTabId = extensionPage
    ? url?.searchParams.get(LINKED_TAB_ID_NAME)
    : null
  const parsed = rawTabId?.trim() ? Number(rawTabId) : NaN
  const linkedTabId =
    Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  return Object.freeze({
    LINKED_TAB_ID_NAME,
    browser:
      options.browser ??
      (extensionUrl.protocol === 'moz-extension:'
        ? 'firefox'
        : extensionUrl.protocol === 'chrome-extension:'
          ? 'chrome'
          : 'unknown'),
    type:
      options.context === undefined
        ? detectContext(api, url, extensionPage, extensionUrl)
        : options.context,
    linkedTabId,
    isPopout:
      extensionPage &&
      (url?.searchParams.get(POPOUT_NAME) === '1' || linkedTabId !== null),
  })
}
