import type Browser from 'webextension-polyfill'
import type { WebExtContext } from '../context'
import type { Messaging } from '../messaging'
import type { PopoutOptions } from '../popout'
import type { SideNativeApi } from './native'
import type { Side, SidePathTarget, SideTarget } from './types'

import { createDisposables, disposeAll } from '../disposables'
import { UnsupportedOperationError } from '../errors'
import { createSidebarCloser } from './close'
import {
  WINDOW_ID_CURRENT,
  assertTabWindow,
  isPanelEnabled,
  validateSidePathTarget,
  validateSideTarget,
} from './native'
import { createChromeSidePaths } from './paths'

export type { PopoutOptions } from '../popout'
export type { SideNativeApi } from './native'
export type {
  Side,
  SideCapabilities,
  SidePathTarget,
  SideTarget,
} from './types'

export { UnsupportedOperationError } from '../errors'

export function createSide(
  api: SideNativeApi,
  helpers: {
    context: WebExtContext
    messaging: Messaging
    resolveTabId(options: PopoutOptions): Promise<number | null>
    normalizePath(path: string): string
    openPopout(
      path: string,
      options?: PopoutOptions
    ): Promise<Browser.Windows.Window | undefined>
  }
) {
  const panel = api.sidePanel
  const sidebar = panel ? undefined : api.sidebarAction
  const disposers = createDisposables()
  const paths = createChromeSidePaths(api, helpers)
  const closer = createSidebarCloser(api, helpers.context, helpers.messaging)
  const pathChannel = helpers.messaging.channel<{
    getPath: { request: SidePathTarget; response: string | undefined }
    setPath: {
      request: { path: string; target: SidePathTarget }
      response: undefined
    }
  }>('@midra/webext/side-paths')
  let initialized = false
  const capabilities = Object.freeze({
    open: !!(panel?.open || sidebar?.open),
    close: !!(panel?.close || sidebar?.close),
    path: !!((panel?.getOptions && panel.setOptions) || sidebar),
    windowPath: !!sidebar || paths.available,
    backgroundClose: panel?.close
      ? ('native' as const)
      : sidebar && closer.available
        ? ('document' as const)
        : (false as const),
    isOpen: sidebar?.isOpen
      ? ('native' as const)
      : panel && api.runtime?.getContexts && api.windows?.getCurrent
        ? ('document' as const)
        : (false as const),
    targetedOpen: !!panel?.open,
    actionClick: !!api.action?.onClicked && !!(panel?.open || sidebar?.open),
  })

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
    validateSidePathTarget(target)
    if (paths.available)
      return helpers.context.type === 'background'
        ? paths.getPath(target)
        : pathChannel.send('getPath', target, { target: 'background' })
    if (panel && target.windowId !== undefined)
      throw new UnsupportedOperationError('side.getPath window target')
    const path = panel?.getOptions
      ? (await panel.getOptions({ ...target })).path
      : sidebar
        ? await sidebar.getPanel({ ...target })
        : undefined
    if (!panel?.getOptions && !sidebar)
      throw new UnsupportedOperationError('side.getPath')
    return path ? helpers.normalizePath(path) : undefined
  }
  async function setPath(
    path: string,
    target: SidePathTarget = {}
  ): Promise<void> {
    validateSidePathTarget(target)
    const normalized = helpers.normalizePath(path)
    if (paths.available)
      return helpers.context.type === 'background'
        ? paths.setPath(normalized, target)
        : pathChannel.send(
            'setPath',
            { path: normalized, target },
            { target: 'background' }
          )
    if (panel && target.windowId !== undefined)
      throw new UnsupportedOperationError('side.setPath window target')
    if (panel?.setOptions)
      return panel.setOptions({ ...target, path: normalized })
    if (sidebar) return sidebar.setPanel({ ...target, panel: `/${normalized}` })
    throw new UnsupportedOperationError('side.setPath')
  }

  async function isOpen(target: SideTarget = {}) {
    validateSideTarget(target)
    let tab: Browser.Tabs.Tab | undefined
    if (target.tabId !== undefined) {
      if (!api.tabs?.get)
        throw new UnsupportedOperationError('side.isOpen tab target')
      tab = await api.tabs.get(target.tabId)
      if (!tab.active) return false
      assertTabWindow(tab, target.windowId)
    }
    if (sidebar?.isOpen)
      return sidebar.isOpen(tab ? { windowId: tab.windowId } : { ...target })
    if (panel && api.runtime?.getContexts && api.windows?.getCurrent) {
      let windowId = tab ? tab.windowId : target.windowId
      if (!tab && (windowId === undefined || windowId === WINDOW_ID_CURRENT))
        windowId = (await api.windows.getCurrent()).id
      if (windowId === undefined) return false
      const contexts = await api.runtime.getContexts({
        contextTypes: ['SIDE_PANEL'],
        windowIds: [windowId],
      })
      if (!tab && !api.tabs?.query) return contexts.length > 0
      let activeTabId = tab?.id
      if (!tab && api.tabs?.query)
        activeTabId = (await api.tabs.query({ active: true, windowId }))[0]?.id
      return contexts.some(
        (context) =>
          context.tabId === activeTabId ||
          context.tabId === -1 ||
          context.tabId === undefined
      )
    }
    throw new UnsupportedOperationError('side.isOpen')
  }

  async function closeChromePanel(target: SideTarget) {
    if (!panel?.close) throw new UnsupportedOperationError('side.close')
    const options = chromeTarget(target)
    // close()は現在のウィンドウ定数を解決しない環境がある。
    if (options.windowId === WINDOW_ID_CURRENT) {
      if (!api.windows?.getCurrent)
        throw new UnsupportedOperationError('side.close current window')
      options.windowId = (await api.windows.getCurrent()).id
      if (options.windowId === undefined)
        throw new Error('No current window is available')
    }

    if (options.tabId !== undefined && panel.getOptions && api.tabs?.get) {
      const tab = await api.tabs.get(options.tabId)
      assertTabWindow(tab, options.windowId)
      const configured = await panel.getOptions({ tabId: options.tabId })
      if (!isPanelEnabled(configured)) return
      if (configured.tabId !== options.tabId)
        return panel.close({ windowId: tab.windowId })
    } else if (
      options.windowId !== undefined &&
      api.tabs?.query &&
      panel.getOptions
    ) {
      // Chromeのwindow指定はglobalだけを閉じるため、tab別の実体も閉じる。
      for (const tab of await api.tabs.query({ windowId: options.windowId })) {
        if (tab.id === undefined) continue
        const configured = await panel.getOptions({ tabId: tab.id })
        if (configured.tabId === tab.id && isPanelEnabled(configured))
          await panel.close({ tabId: tab.id })
      }
    }
    if (
      options.tabId === undefined &&
      panel.getOptions &&
      !isPanelEnabled(await panel.getOptions({}))
    )
      return
    return panel.close(options)
  }

  const side: Side = {
    available: capabilities.open,
    capabilities,
    async open(target = {}) {
      validateSideTarget(target)
      // ユーザー操作の有効期間を保つため、ネイティブ呼び出し前にawaitしない。
      if (panel?.open) return panel.open(chromeTarget(target))
      if (sidebar) {
        requireCurrentWindow(target)
        return sidebar.open()
      }
      throw new UnsupportedOperationError('side.open')
    },
    async close(target = {}) {
      validateSideTarget(target)
      if (panel) return closeChromePanel(target)
      if (sidebar) {
        if (closer.available) return closer.close(target)
        requireCurrentWindow(target)
        return sidebar.close()
      }
      throw new UnsupportedOperationError('side.close')
    },
    getPath,
    setPath,
    isOpen,
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
            panel && tab.id !== undefined
              ? { tabId: tab.id }
              : panel && tab.windowId !== undefined
                ? { windowId: tab.windowId }
                : {}
          )
          .catch(onError)
      }
      api.action!.onClicked.addListener(listener)
      return disposers.add(() => api.action!.onClicked.removeListener(listener))
    },
    dispose() {
      initialized = false
      disposeAll([
        () => disposers.dispose(),
        () => paths.dispose(),
        () => closer.dispose(),
      ])
    },
  }
  function initialize() {
    if (initialized) return
    if (helpers.context.type === 'background' && paths.available) {
      disposers.add(pathChannel.handle('getPath', getPath))
      disposers.add(
        pathChannel.handle('setPath', async ({ path, target }) => {
          await setPath(path, target)
          return undefined
        })
      )
      paths.initialize()
    }
    closer.initialize()
    initialized = true
  }
  return { side, initialize }
}
