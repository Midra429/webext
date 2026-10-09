import type Browser from 'webextension-polyfill'
import type { SideNativeApi } from './native'
import type { SidePathTarget } from './types'

import { createDisposables } from '../disposables'
import { UnsupportedOperationError } from '../errors'
import { WINDOW_ID_CURRENT } from './native'

const STORAGE_KEY = '_webext_side_paths'

interface PathState {
  tabs: Record<number, string>
  windows: Record<number, string>
  inherited: Record<number, true>
}

function getWindowPath(state: PathState, windowId: number | undefined) {
  return windowId === undefined ? undefined : state.windows[windowId]
}

/**
 * backgroundでインスタンスごとに一つだけ作成する、Chromeのwindow別パス補完。
 * メッセージの登録・転送と対象の検証は呼び出し側で行う。
 * scoped設定時にglobalがなければ、そのパスをglobalのfallbackにも登録する。
 */
export function createChromeSidePaths(
  api: SideNativeApi,
  helpers: { normalizePath(path: string): string }
) {
  const panel = api.sidePanel
  const getOptions = panel?.getOptions?.bind(panel)
  const setOptions = panel?.setOptions?.bind(panel)
  const tabs = api.tabs
  const windows = api.windows
  const session = api.storage?.session
  const events = [
    tabs?.onCreated,
    tabs?.onAttached,
    tabs?.onActivated,
    tabs?.onRemoved,
    windows?.onRemoved,
  ]
  const available = !!(
    getOptions &&
    setOptions &&
    typeof tabs?.query === 'function' &&
    typeof tabs?.get === 'function' &&
    typeof windows?.getCurrent === 'function' &&
    typeof session?.get === 'function' &&
    typeof session?.set === 'function' &&
    api.runtime?.onMessage &&
    events.every(
      (event) =>
        typeof event?.addListener === 'function' &&
        typeof event?.removeListener === 'function'
    )
  )
  const disposers = createDisposables()
  let initialized = false
  // 実行中の待機だけを保持し、パスや所有権は毎回sessionから読み直す。
  let pending = Promise.resolve()

  async function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = pending
    let release!: () => void
    pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }

  function native() {
    if (
      !available ||
      !getOptions ||
      !setOptions ||
      !tabs ||
      !windows ||
      !session
    )
      throw new UnsupportedOperationError('Chrome side path overrides')
    return { getOptions, setOptions, tabs, windows, session }
  }

  async function readState(): Promise<PathState> {
    const values = await native().session.get(STORAGE_KEY)
    const stored: Partial<PathState> = values[STORAGE_KEY] ?? {}
    return {
      tabs: { ...stored.tabs },
      windows: { ...stored.windows },
      inherited: { ...stored.inherited },
    }
  }

  async function saveState(state: PathState) {
    await native().session.set({ [STORAGE_KEY]: state })
  }

  function normalize(path: string | undefined) {
    return path ? helpers.normalizePath(path) : undefined
  }

  async function globalPath() {
    return normalize((await native().getOptions({})).path)
  }

  async function ensureGlobal(path: string) {
    const current = await globalPath()
    if (current !== undefined) return current
    await native().setOptions({ path })
    return path
  }

  async function resolveWindowId(windowId: number) {
    if (windowId !== WINDOW_ID_CURRENT) return windowId
    const current = await native().windows.getCurrent()
    if (current.id === undefined)
      throw new Error('Chrome side paths could not resolve the current window')
    return current.id
  }

  async function materialize(
    state: PathState,
    tab: Browser.Tabs.Tab,
    fallback: string | undefined
  ) {
    const tabId = tab.id
    if (tabId === undefined) return
    const explicit = state.tabs[tabId]
    const windowPath = getWindowPath(state, tab.windowId)
    const inherited = state.inherited[tabId]
    // ネイティブの未管理タブは、window overrideの対象になるまで触らない。
    if (explicit === undefined && windowPath === undefined && !inherited) return

    const options = await native().getOptions({ tabId })
    if (explicit === undefined && !inherited && options.tabId === tabId) {
      const existing = normalize(options.path)
      if (existing !== undefined) {
        state.tabs[tabId] = existing
        await saveState(state)
        return
      }
    }

    const path = explicit ?? windowPath ?? fallback
    if (path === undefined) return
    if (explicit === undefined && !inherited) {
      // ネイティブ書き込み前に所有権を保存し、SW再起動時の明示パス誤認を防ぐ。
      state.inherited[tabId] = true
      await saveState(state)
    }
    if (options.tabId !== tabId || options.path !== path)
      await native().setOptions({ tabId, path })
  }

  async function reconcileTab(tabId: number) {
    const tab = await native().tabs.get(tabId)
    const state = await readState()
    await materialize(state, tab, await globalPath())
  }

  async function reconcileAll() {
    const state = await readState()
    const allTabs = await native().tabs.query({})
    const fallback = await globalPath()
    for (const tab of allTabs) await materialize(state, tab, fallback)
  }

  async function eventWork(description: string, work: () => Promise<void>) {
    try {
      await enqueue(work)
    } catch (error) {
      console.error(`webext: Chrome side paths ${description} failed`, error)
    }
  }

  const onCreated = (tab: Browser.Tabs.Tab) => {
    const tabId = tab.id
    if (tabId !== undefined)
      void eventWork(`onCreated for tab ${tabId}`, () => reconcileTab(tabId))
  }
  const onAttached = (tabId: number) => {
    void eventWork(`onAttached for tab ${tabId}`, () => reconcileTab(tabId))
  }
  const onActivated = (info: Browser.Tabs.OnActivatedActiveInfoType) => {
    void eventWork(`onActivated for tab ${info.tabId}`, () =>
      reconcileTab(info.tabId)
    )
  }
  const onTabRemoved = (tabId: number) => {
    void eventWork(`onRemoved for tab ${tabId}`, async () => {
      const state = await readState()
      delete state.tabs[tabId]
      delete state.inherited[tabId]
      await saveState(state)
    })
  }
  const onWindowRemoved = (windowId: number) => {
    void eventWork(`onRemoved for window ${windowId}`, async () => {
      const state = await readState()
      delete state.windows[windowId]
      await saveState(state)
    })
  }

  function listen<Args extends unknown[]>(
    event: Browser.Events.Event<(...args: Args) => void>,
    listener: (...args: Args) => void
  ) {
    event.addListener(listener)
    disposers.add(() => event.removeListener(listener))
  }

  function initialize() {
    if (initialized || !available) return
    const { tabs, windows } = native()
    listen(tabs.onCreated, onCreated)
    listen(tabs.onAttached, onAttached)
    listen(tabs.onActivated, onActivated)
    listen(tabs.onRemoved, onTabRemoved)
    listen(windows.onRemoved, onWindowRemoved)
    initialized = true
    void eventWork('startup reconciliation', reconcileAll)
  }

  async function getPath(
    target: SidePathTarget = {}
  ): Promise<string | undefined> {
    return enqueue(async () => {
      if (target.tabId !== undefined) {
        const tab = await native().tabs.get(target.tabId)
        const state = await readState()
        const explicit = state.tabs[target.tabId]
        if (explicit !== undefined) return explicit
        if (!state.inherited[target.tabId]) {
          const options = await native().getOptions({ tabId: target.tabId })
          if (options.tabId === target.tabId) {
            const existing = normalize(options.path)
            if (existing !== undefined) return existing
          }
        }
        const windowPath = getWindowPath(state, tab.windowId)
        return windowPath ?? (await globalPath())
      }
      if (target.windowId !== undefined) {
        const windowId = await resolveWindowId(target.windowId)
        const state = await readState()
        return state.windows[windowId] ?? (await globalPath())
      }
      return globalPath()
    })
  }

  async function setPath(
    path: string,
    target: SidePathTarget = {}
  ): Promise<void> {
    return enqueue(async () => {
      const normalized = helpers.normalizePath(path)
      const { tabs, setOptions } = native()
      if (target.tabId !== undefined) {
        await ensureGlobal(normalized)
        const state = await readState()
        state.tabs[target.tabId] = normalized
        delete state.inherited[target.tabId]
        await saveState(state)
        await setOptions({ tabId: target.tabId, path: normalized })
        return
      }
      if (target.windowId !== undefined) {
        const windowId = await resolveWindowId(target.windowId)
        const fallback = await ensureGlobal(normalized)
        const state = await readState()
        state.windows[windowId] = normalized
        await saveState(state)
        for (const tab of await tabs.query({ windowId }))
          await materialize(state, tab, fallback)
        return
      }
      await setOptions({ path: normalized })
      const state = await readState()
      for (const tab of await tabs.query({}))
        await materialize(state, tab, normalized)
    })
  }

  return {
    available,
    initialize,
    getPath,
    setPath,
    dispose() {
      disposers.dispose()
      initialized = false
    },
  }
}
