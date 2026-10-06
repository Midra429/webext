import type Browser from 'webextension-polyfill'
import type { WebExtContext } from './context'
import type { MessageChannel, Messaging } from './messaging'

import { UnsupportedOperationError } from './errors'
import { facade } from './facade'

/**
 * ネイティブのtabs APIに、実行コンテキストを考慮したタブ取得ヘルパーを追加したAPI。
 *
 * @remarks
 * コンテンツスクリプトでは、backgroundのトップレベルで `webext.initialize()` を呼ぶと
 * 共通ヘルパーを内部メッセージ経由で利用できます。ネイティブの `query()` などを
 * コンテンツスクリプトへ公開するものではありません。
 * タブIDの取得自体に `tabs` 権限が一律に必要なわけではありませんが、返されるタブの
 * `url`・`pendingUrl`・`title`・`favIconUrl` などの情報には `tabs` または対象のホスト権限が必要です。
 * ヘルパーの失敗はPromiseの拒否として伝播します。
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/query
 */
export type WebExtTabs = Browser.Tabs.Static & {
  /** ネイティブのtabs APIが存在するか。`false` でも内部ブリッジ経由の共通ヘルパーは利用できます。 */
  readonly available: boolean
  /**
   * 現在のウィンドウのアクティブタブを取得します。ポップアウトの関連付け先は優先しません。
   *
   * @returns 条件に合う最初のタブ。タブがなければ `undefined`。
   * @remarks
   * ネイティブでは `query({ active: true, currentWindow: true })` を使います。
   * 内部ブリッジ経由では、送信元タブのウィンドウIDがあればそのウィンドウに限定して検索します。
   * 受信先がない場合やネイティブAPIの失敗は、メッセージング・ネイティブのエラーで拒否されます。
   * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#method-query
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/query
   */
  getCurrentActive(): Promise<Browser.Tabs.Tab | undefined>
  /**
   * `getCurrentActive()` で取得したタブのIDを返します。
   * @returns タブID。タブまたはIDがなければ `undefined`。取得エラーは伝播します。
   */
  getCurrentActiveId(): Promise<number | undefined>
  /**
   * 関連付け先タブ、コンテンツスクリプト自身のタブ、アクティブタブの順に対象を解決します。
   *
   * @returns 解決したタブ。対象がなければ `undefined`。
   * @remarks
   * `context.linkedTabId` があればネイティブの `tabs.get()` を使います。
   * 未指定ならコンテンツスクリプトでは `getSelf()`、それ以外では `getCurrentActive()` を使います。
   * 関連付け先が閉じられていても別のタブへフォールバックせず、取得エラーを伝播します。
   * @throws {UnsupportedOperationError} 関連付け先が指定されているのにネイティブのtabs APIがない場合。
   * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#method-get
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/get
   */
  getTarget(): Promise<Browser.Tabs.Tab | undefined>
  /**
   * `getTarget()` で解決したタブのIDを返します。
   * @returns タブID。対象タブまたはIDがなければ `undefined`。取得エラーは伝播します。
   */
  getTargetId(): Promise<number | undefined>
  /**
   * このスクリプト自身を含むタブを取得します。アクティブタブや関連付け先とは異なります。
   *
   * @returns 自身を含むタブ。backgroundや通常のaction popupなど、タブに属さなければ `undefined`。
   * @remarks
   * コンテンツスクリプト、またはネイティブのtabs APIがない環境では、backgroundが受け取る
   * `MessageSender.tab` を利用します。それ以外ではネイティブの `tabs.getCurrent()` を使います。
   * ブリッジの未登録やネイティブの取得失敗はエラーとして伝播します。
   * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#method-getCurrent
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/getCurrent
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender
   */
  getSelf(): Promise<Browser.Tabs.Tab | undefined>
  /**
   * `getSelf()` で取得した自身のタブIDを返します。
   * @returns タブID。自身のタブまたはIDがなければ `undefined`。取得エラーは伝播します。
   */
  getSelfId(): Promise<number | undefined>
}

interface InternalMessages {
  selfTab: { request: null; response: Browser.Tabs.Tab | undefined }
  activeTab: { request: null; response: Browser.Tabs.Tab | undefined }
}

export function createTabs(
  api: { tabs?: Browser.Tabs.Static },
  context: WebExtContext,
  messaging: Messaging
): { tabs: WebExtTabs; initialize(): void } {
  const native = api.tabs
  let internal: MessageChannel<InternalMessages> | undefined
  let initialized = false
  // 拡張ページからネイティブAPIだけを使う場合はブリッジを作成しない。
  const bridge = () =>
    (internal ??= messaging.channel<InternalMessages>('@midra/webext/internal'))

  async function queryActive(windowId?: number) {
    if (!native) throw new UnsupportedOperationError('background tab bridge')
    return (
      await native.query(
        windowId === undefined
          ? { active: true, currentWindow: true }
          : { active: true, windowId }
      )
    )[0]
  }
  function initialize() {
    if (initialized || context.type !== 'background') return
    if (!native) throw new UnsupportedOperationError('background tab bridge')
    bridge().handle('selfTab', (_request, sender) => sender.tab)
    bridge().handle('activeTab', (_request, sender) =>
      queryActive(sender.tab?.windowId)
    )
    initialized = true
  }
  async function getCurrentActive() {
    return native ? queryActive() : bridge().send('activeTab', null)
  }
  async function getSelf() {
    if (context.type === 'content-script' || !native)
      return bridge().send('selfTab', null)
    return native.getCurrent?.()
  }
  async function getTarget() {
    if (context.linkedTabId !== null) {
      if (!native) throw new UnsupportedOperationError('tabs.get linked target')
      return native.get(context.linkedTabId)
    }
    return context.type === 'content-script' ? getSelf() : getCurrentActive()
  }

  const tabs = facade(native ?? {}, {
    available: !!native,
    getCurrentActive,
    async getCurrentActiveId() {
      return (await getCurrentActive())?.id
    },
    getTarget,
    async getTargetId() {
      return (await getTarget())?.id
    },
    getSelf,
    async getSelfId() {
      return (await getSelf())?.id
    },
  }) as WebExtTabs
  return { tabs, initialize }
}
