import type { WebExtContext } from '../context'
import type { Messaging } from '../messaging'
import type { SideNativeApi } from './native'
import type { SideTarget } from './types'

import { UnsupportedOperationError } from '../errors'
import { WINDOW_ID_CURRENT, assertTabWindow } from './native'

interface CloseMessage {
  close: { request: null; response: null }
}

interface SidebarRegistration {
  windowId: number
  documentWindow: Window
  stop(): void
}

const CLOSE_CHECK_ATTEMPTS = 20
const CLOSE_CHECK_INTERVAL_MS = 25

/** Firefox 133+のsidebarドキュメントに、自身を閉じる処理を依頼する。 */
export function createSidebarCloser(
  api: SideNativeApi,
  context: WebExtContext,
  messaging: Messaging
) {
  const available = !!(
    api.sidebarAction?.isOpen &&
    api.windows?.getCurrent &&
    api.runtime?.sendMessage &&
    api.runtime?.onMessage &&
    api.tabs?.getCurrent
  )
  const channel = (windowId: number) =>
    messaging.channel<CloseMessage>(`@midra/webext/side-close/${windowId}`)
  let ready: Promise<void> | undefined
  let registration: SidebarRegistration | undefined
  let generation = 0

  async function register(version: number, panelWindow: Window) {
    // 同じHTMLを通常タブ・ポップアウトで開いても、それらは閉じない。
    if (await api.tabs?.getCurrent?.()) return
    const windowId = (await api.windows!.getCurrent()).id
    if (windowId === undefined || version !== generation) return
    registration = {
      windowId,
      documentWindow: panelWindow,
      stop: channel(windowId).handle('close', () => {
        // 応答を送ってからドキュメントを閉じる。SWではなくパネル内の短い遅延。
        setTimeout(() => panelWindow.close(), 0)
        return null
      }),
    }
  }

  function initialize() {
    if (
      ready ||
      !available ||
      context.type !== 'sidepanel' ||
      context.isPopout ||
      typeof window === 'undefined' ||
      window !== window.top
    )
      return
    ready = register(generation, window)
    void reportRegistration(ready)
  }

  async function reportRegistration(registration: Promise<void>) {
    try {
      await registration
    } catch (error) {
      console.error('webext: sidebar close listener registration failed', error)
    }
  }

  async function close(target: SideTarget) {
    if (!available)
      throw new UnsupportedOperationError('side.close sidebar document bridge')
    let windowId = target.windowId
    if (target.tabId !== undefined) {
      if (!api.tabs?.get)
        throw new UnsupportedOperationError('side.close tab target')
      const tab = await api.tabs.get(target.tabId)
      if (!tab.active) return
      assertTabWindow(tab, windowId)
      windowId = tab.windowId
    }
    if (windowId === undefined || windowId === WINDOW_ID_CURRENT)
      windowId = (await api.windows!.getCurrent()).id
    if (windowId === undefined)
      throw new Error('No current window is available')
    if (!(await api.sidebarAction!.isOpen!({ windowId }))) return
    await ready
    if (registration?.windowId === windowId) registration.documentWindow.close()
    else await channel(windowId).send('close', null)
    await waitUntilClosed(windowId)
  }

  async function waitUntilClosed(windowId: number) {
    // メッセージ応答は閉じる要求の受理だけ。実際の終了も確認する。
    for (let attempt = 0; attempt < CLOSE_CHECK_ATTEMPTS; attempt++) {
      if (!(await api.sidebarAction!.isOpen!({ windowId }))) return
      await new Promise((resolve) =>
        setTimeout(resolve, CLOSE_CHECK_INTERVAL_MS)
      )
    }
    throw new Error(
      'The sidebar document did not close (requires Firefox 133+ and panel initialization)'
    )
  }

  return {
    available,
    initialize,
    close,
    dispose() {
      generation++
      registration?.stop()
      registration = undefined
      ready = undefined
    },
  }
}
