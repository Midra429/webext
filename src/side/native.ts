import type Browser from 'webextension-polyfill'
import type { SidePathTarget, SideTarget } from './types'

import { assertTabId } from '../errors'

export const WINDOW_ID_CURRENT = -2

export interface SidePanelOptions {
  path?: string
  tabId?: number
  enabled?: boolean
}

export interface SideNativeApi {
  sidePanel?: {
    open?(options: SideTarget): Promise<void>
    close?(options: SideTarget): Promise<void>
    getOptions?(options: { tabId?: number }): Promise<SidePanelOptions>
    setOptions?(options: { tabId?: number; path: string }): Promise<void>
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
    }): Promise<{ windowId: number; tabId?: number }[]>
    onMessage?: Browser.Runtime.Static['onMessage']
    sendMessage?: Browser.Runtime.Static['sendMessage']
  }
  tabs?: Browser.Tabs.Static
  storage?: { session?: Pick<Browser.Storage.StorageArea, 'get' | 'set'> }
  windows?: Browser.Windows.Static
  action?: { onClicked: Browser.Action.Static['onClicked'] }
}

export function validateSideTarget(target: SideTarget) {
  if (target.tabId !== undefined) assertTabId(target.tabId)
  if (
    target.windowId !== undefined &&
    (!Number.isSafeInteger(target.windowId) ||
      (target.windowId < 0 && target.windowId !== WINDOW_ID_CURRENT))
  )
    throw new TypeError('Invalid window ID')
}

export function validateSidePathTarget(target: SidePathTarget) {
  validateSideTarget(target)
  if (target.tabId !== undefined && target.windowId !== undefined)
    throw new TypeError('Specify either tabId or windowId, not both')
}

export function assertTabWindow(tab: { windowId?: number }, windowId?: number) {
  if (
    windowId !== undefined &&
    windowId !== WINDOW_ID_CURRENT &&
    windowId !== tab.windowId
  )
    throw new TypeError('Tab does not belong to the specified window')
}

export function isPanelEnabled(options: SidePanelOptions) {
  return !!options.path && options.enabled !== false
}
