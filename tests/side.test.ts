import type { CreateWebExtOptions, WebExt } from '../src'
import type { SidePathTarget, SideTarget } from '../src/side'

import { afterEach, expect, mock, test } from 'bun:test'

import { RemoteError, createWebExt } from '../src'

const STORAGE_KEY = '_webext_side_paths'
const instances = new Set<WebExt>()

afterEach(() => {
  for (const instance of instances) instance.dispose()
  instances.clear()
})

function event<Args extends unknown[], Result = void>() {
  const listeners = new Set<(...args: Args) => Result>()
  return {
    listeners,
    addListener: mock((listener: (...args: Args) => Result) => {
      listeners.add(listener)
    }),
    removeListener: mock((listener: (...args: Args) => Result) => {
      listeners.delete(listener)
    }),
    emit(...args: Args) {
      return [...listeners].map((listener) => listener(...args))
    },
  }
}

type Sender = { id: string; url: string }
type Respond = (response: unknown) => void

function messageBus(protocol: string) {
  const endpoints = new Set<
    ReturnType<typeof event<[unknown, Sender, Respond], unknown>>
  >()
  return {
    runtime() {
      const onMessage = event<[unknown, Sender, Respond], unknown>()
      endpoints.add(onMessage)
      return {
        id: 'test',
        getURL: (path: string) =>
          `${protocol}//test/${path.startsWith('/') ? path.slice(1) : path}`,
        getManifest: () => ({ permissions: ['storage', 'sidePanel'] }),
        onMessage,
        sendMessage: mock(
          (message: unknown) =>
            new Promise<unknown>((resolve, reject) => {
              let handled = false
              const respond: Respond = (response) =>
                resolve(structuredClone(response))
              try {
                for (const endpoint of endpoints) {
                  // runtime.sendMessage does not deliver to its sending context.
                  if (endpoint === onMessage) continue
                  for (const listener of [...endpoint.listeners]) {
                    const result = listener(
                      structuredClone(message),
                      { id: 'test', url: `${protocol}//test/ui/popup.html` },
                      respond
                    )
                    if (result === true) handled = true
                  }
                }
                if (!handled) reject(new Error('No receiver'))
              } catch (error) {
                reject(error)
              }
            })
        ),
      }
    },
  }
}

type Tab = { id: number; windowId: number; active: boolean }
type PanelOptions = { path?: string; tabId?: number; enabled?: boolean }
type PanelContext = { windowId: number; tabId?: number }
type PathState = {
  tabs: Record<number, string>
  windows: Record<number, string>
  inherited: Record<number, true>
}

function browserMock(
  browser: 'chrome' | 'firefox' = 'chrome',
  path: string | undefined = 'global.html'
) {
  const protocol = browser === 'chrome' ? 'chrome-extension:' : 'moz-extension:'
  const bus = messageBus(protocol)
  const tabState = new Map<number, Tab>([
    [11, { id: 11, windowId: 10, active: true }],
    [12, { id: 12, windowId: 10, active: false }],
    [21, { id: 21, windowId: 20, active: true }],
    [22, { id: 22, windowId: 20, active: false }],
  ])
  const stored: Record<string, unknown> = {}
  const globalOptions: PanelOptions = { path, enabled: true }
  const tabOptions = new Map<number, PanelOptions>()
  const windowPanels = new Map<number, string>()
  let contexts: PanelContext[] = []
  let currentWindowId = 10
  const tabs = {
    get: mock(async (tabId: number) => {
      const tab = tabState.get(tabId)
      if (!tab) throw new Error(`No tab ${tabId}`)
      return { ...tab }
    }),
    getCurrent: mock(async () => undefined),
    query: mock(
      async (query: {
        windowId?: number
        active?: boolean
        currentWindow?: boolean
      }) =>
        [...tabState.values()]
          .filter(
            (tab) =>
              (query.windowId === undefined ||
                tab.windowId === query.windowId) &&
              (!query.currentWindow || tab.windowId === currentWindowId) &&
              (query.active === undefined || tab.active === query.active)
          )
          .map((tab) => ({ ...tab }))
    ),
    onCreated: event<[Tab]>(),
    onAttached: event<[number, { newWindowId: number; newPosition: number }]>(),
    onActivated: event<[{ tabId: number; windowId: number }]>(),
    onRemoved:
      event<[number, { windowId: number; isWindowClosing: boolean }]>(),
  }
  const windows = {
    getCurrent: mock(async () => ({ id: currentWindowId })),
    onRemoved: event<[number]>(),
  }
  const session = {
    get: mock(async (key: string) =>
      Object.hasOwn(stored, key) ? { [key]: structuredClone(stored[key]) } : {}
    ),
    set: mock(async (items: Record<string, unknown>) => {
      Object.assign(stored, structuredClone(items))
    }),
  }
  const sidePanel = {
    open: mock(async (_target: SideTarget) => {}),
    close: mock(async (_target: SideTarget) => {}),
    getOptions: mock(
      async ({ tabId }: { tabId?: number }): Promise<PanelOptions> => {
        // Chrome omits tabId when the requested tab inherits the global panel.
        if (tabId !== undefined && tabOptions.has(tabId))
          return { ...tabOptions.get(tabId), tabId }
        return { ...globalOptions }
      }
    ),
    setOptions: mock(
      async ({ tabId, path }: { tabId?: number; path: string }) => {
        if (tabId === undefined) globalOptions.path = path
        else tabOptions.set(tabId, { ...tabOptions.get(tabId), path, tabId })
      }
    ),
  }
  const runtime = {
    ...bus.runtime(),
    getContexts: mock(
      async (filter: { contextTypes: string[]; windowIds?: number[] }) =>
        contexts
          .filter(
            (context) =>
              !filter.windowIds || filter.windowIds.includes(context.windowId)
          )
          .map((context) => ({ ...context }))
    ),
  }
  const sidebarAction = {
    open: mock(async () => {}),
    close: mock(async () => {}),
    getPanel: mock(async (target: SidePathTarget) => {
      const tab =
        target.tabId === undefined ? undefined : tabState.get(target.tabId)
      const windowId =
        target.windowId === -2
          ? currentWindowId
          : (target.windowId ?? tab?.windowId)
      const configured =
        (target.tabId === undefined
          ? undefined
          : tabOptions.get(target.tabId)?.path) ??
        (windowId === undefined ? undefined : windowPanels.get(windowId)) ??
        globalOptions.path
      return configured ? new URL(configured, runtime.getURL('/')).href : ''
    }),
    setPanel: mock(
      async ({ panel, ...target }: SidePathTarget & { panel: string }) => {
        const configured = new URL(panel, runtime.getURL('/')).href
        if (target.tabId !== undefined)
          tabOptions.set(target.tabId, { path: configured })
        else if (target.windowId !== undefined)
          windowPanels.set(
            target.windowId === -2 ? currentWindowId : target.windowId,
            configured
          )
        else globalOptions.path = configured
      }
    ),
    isOpen: mock(async (_target: { windowId?: number }) => true),
  }
  const api = {
    runtime,
    tabs,
    windows,
    storage: { session },
    action: { onClicked: event<[Tab]>() },
    ...(browser === 'chrome' ? { sidePanel } : { sidebarAction }),
  }
  return {
    api,
    bus,
    tabs,
    windows,
    session,
    sidePanel,
    sidebarAction,
    tabState,
    tabOptions,
    globalOptions,
    pathEvents: [
      tabs.onCreated,
      tabs.onAttached,
      tabs.onActivated,
      tabs.onRemoved,
      windows.onRemoved,
    ],
    state: () => structuredClone(stored[STORAGE_KEY]) as PathState | undefined,
    setContexts(value: PanelContext[]) {
      contexts = value
    },
    setCurrentWindow(windowId: number) {
      currentWindowId = windowId
    },
  }
}

function create(
  api: unknown,
  context: CreateWebExtOptions['context'] = 'background'
) {
  const instance = createWebExt({
    api: api as CreateWebExtOptions['api'],
    context,
  })
  instances.add(instance)
  return instance
}

async function setup(browser: 'chrome' | 'firefox' = 'chrome', path?: string) {
  const native = browserMock(browser, path)
  const webext = create(native.api)
  // The path queue is a deterministic barrier for startup and event reconciliation.
  await webext.side.getPath()
  return { ...native, webext, side: webext.side }
}

test.each([0, 1, 2, 3, 4])(
  'failed background initialization releases prior listeners when path event %i rejects registration',
  (index) => {
    const env = browserMock()
    const failure = new Error('Path listener registration failed')
    env.pathEvents[index]!.addListener.mockImplementationOnce(() => {
      throw failure
    })
    expect(() => create(env.api)).toThrow(failure)
    expect(env.api.runtime.onMessage.listeners.size).toBe(0)
    for (const event of env.pathEvents) expect(event.listeners.size).toBe(0)
    const webext = create(env.api)
    expect(env.api.runtime.onMessage.listeners.size).toBe(1)
    for (const event of env.pathEvents) expect(event.listeners.size).toBe(1)
    webext.dispose()
  }
)

test('failed initialization retains both registration and cleanup errors while releasing other listeners', () => {
  const env = browserMock()
  const registrationFailure = new Error('Path registration failed')
  const cleanupFailure = new Error('Path cleanup failed')
  env.tabs.onAttached.addListener.mockImplementationOnce(() => {
    throw registrationFailure
  })
  env.tabs.onCreated.removeListener.mockImplementationOnce((listener) => {
    env.tabs.onCreated.listeners.delete(listener)
    throw cleanupFailure
  })
  let caught: unknown
  try {
    create(env.api)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AggregateError)
  expect((caught as AggregateError).errors).toEqual([
    registrationFailure,
    cleanupFailure,
  ])
  expect(env.api.runtime.onMessage.listeners.size).toBe(0)
  for (const event of env.pathEvents) expect(event.listeners.size).toBe(0)
})

test('instance disposal continues through other subsystems after a native cleanup fails', async () => {
  const env = browserMock()
  const changes = event<[Record<string, { newValue?: unknown }>, string]>()
  const webext = create({
    ...env.api,
    storage: { ...env.api.storage, onChanged: changes },
  })
  await webext.side.getPath()
  const failure = new Error('Action cleanup failed')
  env.api.action.onClicked.removeListener.mockImplementationOnce((listener) => {
    env.api.action.onClicked.listeners.delete(listener)
    throw failure
  })
  webext.side.bindActionClick(() => {})
  webext.storage.session!.watch('theme', () => {})
  expect(() => webext.dispose()).toThrow(failure)
  expect(env.api.runtime.onMessage.listeners.size).toBe(0)
  for (const event of env.pathEvents) expect(event.listeners.size).toBe(0)
  expect(env.api.action.onClicked.listeners.size).toBe(0)
  expect(changes.listeners.size).toBe(0)
  expect(() => webext.dispose()).not.toThrow()
})

for (const browser of ['chrome', 'firefox'] as const) {
  test.each([
    { tabId: -1 },
    { tabId: -2 },
    { tabId: NaN },
    { tabId: Infinity },
    { tabId: 0.5 },
    { tabId: Number.MAX_SAFE_INTEGER + 1 },
    { windowId: -1 },
    { windowId: -3 },
    { windowId: NaN },
    { windowId: Infinity },
    { windowId: 0.5 },
    { windowId: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    `${browser} validates targets consistently before any side operation: %j`,
    async (target) => {
      const env = await setup(browser)
      env.sidePanel.getOptions.mockClear()
      env.sidebarAction.getPanel.mockClear()
      env.session.get.mockClear()
      env.tabs.get.mockClear()
      env.windows.getCurrent.mockClear()
      await expect(env.side.open(target)).rejects.toBeInstanceOf(TypeError)
      await expect(env.side.close(target)).rejects.toBeInstanceOf(TypeError)
      await expect(env.side.getPath(target)).rejects.toBeInstanceOf(TypeError)
      await expect(
        env.side.setPath('side.html', target)
      ).rejects.toBeInstanceOf(TypeError)
      await expect(env.side.isOpen(target)).rejects.toBeInstanceOf(TypeError)
      for (const operation of [
        env.sidePanel.open,
        env.sidePanel.close,
        env.sidePanel.getOptions,
        env.sidePanel.setOptions,
        env.sidebarAction.open,
        env.sidebarAction.close,
        env.sidebarAction.getPanel,
        env.sidebarAction.setPanel,
        env.sidebarAction.isOpen,
        env.session.get,
        env.session.set,
        env.tabs.get,
        env.windows.getCurrent,
      ])
        expect(operation).not.toHaveBeenCalled()
    }
  )
}

test('Chrome window paths persist in session and materialize every tab, not only the active tab', async () => {
  const env = await setup()
  expect(env.side.capabilities.windowPath).toBe(true)
  expect(await env.sidePanel.getOptions({ tabId: 11 })).toEqual({
    path: 'global.html',
    enabled: true,
  })
  await env.side.setPath(
    'chrome-extension://test/ui/window.html?q=1#section',
    Object.freeze({ windowId: 10 })
  )
  expect(env.state()).toEqual({
    tabs: {},
    windows: { 10: 'ui/window.html?q=1#section' },
    inherited: { 11: true, 12: true },
  })
  expect(env.session.set).toHaveBeenCalled()
  expect(env.tabs.query).toHaveBeenCalledWith({ windowId: 10 })
  for (const tabId of [11, 12]) {
    expect(env.tabOptions.get(tabId)?.path).toBe('ui/window.html?q=1#section')
    expect(env.sidePanel.setOptions).toHaveBeenCalledWith({
      tabId,
      path: 'ui/window.html?q=1#section',
    })
  }
  expect(env.tabOptions.has(21)).toBe(false)
  expect(env.tabOptions.has(22)).toBe(false)
  expect(env.globalOptions.path).toBe('global.html')
  expect(env.sidePanel.open).not.toHaveBeenCalled()
})

test.each(['tab', 'window'] as const)(
  'Chrome seeds a missing global fallback when setting a %s path',
  async (scope) => {
    const env = browserMock()
    delete env.globalOptions.path
    const webext = create(env.api)
    await webext.side.setPath(
      '/first.html',
      scope === 'tab' ? { tabId: 11 } : { windowId: 10 }
    )
    expect(await webext.side.getPath()).toBe('first.html')
    expect(await webext.side.getPath({ tabId: 21 })).toBe('first.html')
    expect(env.sidePanel.setOptions).toHaveBeenCalledWith({
      path: 'first.html',
    })
  }
)

test('Chrome resolves tab > window > global and keeps two windows independent', async () => {
  const env = await setup()
  await env.side.setPath('window-a.html', { windowId: 10 })
  await env.side.setPath('window-b.html', { windowId: 20 })
  await env.side.setPath('tab.html', { tabId: 11 })
  await env.side.setPath('global-new.html')
  expect(await env.side.getPath()).toBe('global-new.html')
  expect(await env.side.getPath({ tabId: 11 })).toBe('tab.html')
  expect(await env.side.getPath({ tabId: 12 })).toBe('window-a.html')
  expect(await env.side.getPath({ tabId: 21 })).toBe('window-b.html')
  expect(await env.side.getPath({ tabId: 22 })).toBe('window-b.html')
  expect(await env.side.getPath({ windowId: 10 })).toBe('window-a.html')
  expect(await env.side.getPath({ windowId: 20 })).toBe('window-b.html')
  expect(await env.side.getPath({ windowId: 30 })).toBe('global-new.html')
  await env.side.setPath('window-a-new.html', { windowId: 10 })
  expect(env.tabOptions.get(11)?.path).toBe('tab.html')
  expect(env.tabOptions.get(12)?.path).toBe('window-a-new.html')
  expect(env.tabOptions.get(21)?.path).toBe('window-b.html')
  expect(env.tabOptions.get(22)?.path).toBe('window-b.html')
})

test('Chrome preserves native tab overrides but does not mistake global getOptions fallback for a tab override', async () => {
  const env = await setup()
  env.tabOptions.set(11, {
    path: 'native.html?q=1#tab',
    enabled: false,
  })
  expect(await env.side.getPath({ tabId: 11 })).toBe('native.html?q=1#tab')
  await env.side.setPath('window.html', { windowId: 10 })
  await env.side.setPath('global-new.html')
  await env.side.setPath('window-new.html', { windowId: 10 })
  expect(env.state()).toEqual({
    tabs: { 11: 'native.html?q=1#tab' },
    windows: { 10: 'window-new.html' },
    inherited: { 12: true },
  })
  expect(env.tabOptions.get(11)).toEqual({
    path: 'native.html?q=1#tab',
    enabled: false,
  })
  expect(env.tabOptions.get(12)?.path).toBe('window-new.html')
  expect(
    env.sidePanel.setOptions.mock.calls.some(
      ([options]) => options.tabId === 11
    )
  ).toBe(false)
})

test('Chrome current-window path targets resolve -2 before saving and materializing', async () => {
  const env = await setup()
  env.setCurrentWindow(20)
  await env.side.setPath('current.html', { windowId: -2 })
  expect(await env.side.getPath({ windowId: -2 })).toBe('current.html')
  expect(env.state()?.windows).toEqual({ 20: 'current.html' })
  expect(env.tabOptions.get(21)?.path).toBe('current.html')
  expect(env.tabOptions.get(22)?.path).toBe('current.html')
  expect(env.tabOptions.has(11)).toBe(false)
})

test('Chrome onCreated synchronizes a new inactive tab to its window path', async () => {
  const env = await setup()
  await env.side.setPath('window.html', { windowId: 10 })
  const tab = { id: 13, windowId: 10, active: false }
  env.tabState.set(tab.id, tab)
  env.tabs.onCreated.emit(tab)
  await env.side.getPath()
  expect(env.tabOptions.get(13)?.path).toBe('window.html')
  expect(env.state()?.inherited[13]).toBe(true)
})

test.each(['onAttached', 'onActivated'] as const)(
  'Chrome %s replaces inherited paths when tabs move between windows and back to global',
  async (name) => {
    const env = await setup()
    await env.side.setPath('window-a.html', { windowId: 10 })
    await env.side.setPath('window-b.html', { windowId: 20 })
    const tab = env.tabState.get(12)!
    function move(windowId: number) {
      tab.windowId = windowId
      if (name === 'onAttached')
        env.tabs.onAttached.emit(12, { newWindowId: windowId, newPosition: 0 })
      else {
        for (const other of env.tabState.values())
          if (other.windowId === windowId) other.active = false
        tab.active = true
        env.tabs.onActivated.emit({ tabId: 12, windowId })
      }
    }
    move(20)
    await env.side.getPath()
    expect(env.tabOptions.get(12)?.path).toBe('window-b.html')
    expect(await env.side.getPath({ tabId: 12 })).toBe('window-b.html')
    move(30)
    await env.side.getPath()
    expect(env.tabOptions.get(12)?.path).toBe('global.html')
    await env.side.setPath('global-new.html')
    expect(env.tabOptions.get(12)?.path).toBe('global-new.html')
    move(10)
    await env.side.getPath()
    expect(env.tabOptions.get(12)?.path).toBe('window-a.html')
  }
)

test('Chrome attachment and activation do not overwrite an explicit tab path', async () => {
  const env = await setup()
  await env.side.setPath('window-a.html', { windowId: 10 })
  await env.side.setPath('window-b.html', { windowId: 20 })
  await env.side.setPath('tab.html', { tabId: 11 })
  env.tabState.get(11)!.windowId = 20
  env.tabs.onAttached.emit(11, { newWindowId: 20, newPosition: 0 })
  env.tabs.onActivated.emit({ tabId: 11, windowId: 20 })
  await env.side.getPath()
  expect(env.tabOptions.get(11)?.path).toBe('tab.html')
  expect(await env.side.getPath({ tabId: 11 })).toBe('tab.html')
  expect(env.state()?.tabs).toEqual({ 11: 'tab.html' })
  expect(env.state()?.inherited[11]).toBeUndefined()
})

test('Chrome removal events clean session ownership without deleting other tabs or windows', async () => {
  const env = await setup()
  await env.side.setPath('window-a.html', { windowId: 10 })
  await env.side.setPath('window-b.html', { windowId: 20 })
  await env.side.setPath('tab.html', { tabId: 11 })
  for (const tabId of [11, 12]) {
    env.tabState.delete(tabId)
    env.tabOptions.delete(tabId)
    env.tabs.onRemoved.emit(tabId, { windowId: 10, isWindowClosing: true })
  }
  env.windows.onRemoved.emit(10)
  await env.side.getPath()
  expect(env.state()).toEqual({
    tabs: {},
    windows: { 20: 'window-b.html' },
    inherited: { 21: true, 22: true },
  })
  const replacement = { id: 11, windowId: 30, active: true }
  env.tabState.set(11, replacement)
  env.tabs.onCreated.emit(replacement)
  await env.side.getPath()
  expect(await env.side.getPath({ tabId: 11 })).toBe('global.html')
  expect(env.tabOptions.has(11)).toBe(false)
})

test('Chrome a recreated background inherits session paths and does not reclassify materialized paths as explicit', async () => {
  const env = await setup()
  await env.side.setPath('window-a.html', { windowId: 10 })
  await env.side.setPath('window-b.html', { windowId: 20 })
  await env.side.setPath('tab.html', { tabId: 11 })
  const before = env.state()
  env.webext.dispose()
  expect(env.state()).toEqual(before)
  // A tab can move while the previous background is not running.
  env.tabState.get(12)!.windowId = 20
  const next = create(env.api)
  await next.side.getPath()
  expect(env.tabOptions.get(12)?.path).toBe('window-b.html')
  expect(env.state()?.tabs).toEqual({ 11: 'tab.html' })
  await next.side.setPath('window-b-new.html', { windowId: 20 })
  expect(env.tabOptions.get(12)?.path).toBe('window-b-new.html')
  expect(await next.side.getPath({ tabId: 11 })).toBe('tab.html')
  expect(env.api.runtime.onMessage.listeners.size).toBe(1)
  for (const event of env.pathEvents) expect(event.listeners.size).toBe(1)
})

test('Chrome initialize registers synchronously once; dispose removes listeners once and leaves settings intact', async () => {
  const env = browserMock()
  const webext = create(env.api)
  expect(env.api.runtime.onMessage.listeners.size).toBe(1)
  for (const event of env.pathEvents) expect(event.listeners.size).toBe(1)
  webext.initialize()
  webext.initialize()
  expect(env.api.runtime.onMessage.addListener).toHaveBeenCalledTimes(1)
  for (const event of env.pathEvents)
    expect(event.addListener).toHaveBeenCalledTimes(1)
  await webext.side.setPath('window.html', { windowId: 10 })
  webext.side.bindActionClick(() => {})
  const state = env.state()
  const options = [...env.tabOptions]
  webext.dispose()
  webext.dispose()
  expect(env.api.runtime.onMessage.listeners.size).toBe(0)
  expect(env.api.runtime.onMessage.removeListener).toHaveBeenCalledTimes(1)
  expect(env.api.action.onClicked.listeners.size).toBe(0)
  for (const event of env.pathEvents) {
    expect(event.listeners.size).toBe(0)
    expect(event.removeListener).toHaveBeenCalledTimes(1)
  }
  env.tabs.onRemoved.emit(11, { windowId: 10, isWindowClosing: false })
  env.windows.onRemoved.emit(10)
  await webext.side.getPath()
  expect(env.state()).toEqual(state)
  expect([...env.tabOptions]).toEqual(options)
  expect(env.sidePanel.close).not.toHaveBeenCalled()
})

test('Chrome popup paths use the real runtime bus and background session rather than a separate local state', async () => {
  const env = await setup()
  const runtime = { ...env.api.runtime, ...env.bus.runtime() }
  const popup = create({ ...env.api, runtime }, 'popup')
  expect(runtime.onMessage.listeners.size).toBe(0)
  await popup.side.setPath('window.html', { windowId: 20 })
  expect(env.state()?.windows).toEqual({ 20: 'window.html' })
  expect(env.tabOptions.get(22)?.path).toBe('window.html')
  expect(await popup.side.getPath({ tabId: 22 })).toBe('window.html')
  expect(await env.side.getPath({ windowId: 20 })).toBe('window.html')
  expect(runtime.sendMessage).toHaveBeenCalledTimes(2)
  expect(runtime.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    __webext_rpc__: 1,
    channel: '@midra/webext/side-paths',
    type: 'setPath',
    payload: { path: 'window.html', target: { windowId: 20 } },
  })
  for (const event of env.pathEvents) expect(event.listeners.size).toBe(1)
  env.webext.dispose()
  await expect(popup.side.getPath({ windowId: 20 })).rejects.toThrow(
    'No receiver'
  )
})

test.each(['chrome', 'firefox'] as const)(
  '%s rejects both path target IDs without invoking native APIs or saving state',
  async (browser) => {
    const env = await setup(browser)
    const target = Object.freeze({ tabId: 11, windowId: 10 })
    const state = env.state()
    env.sidePanel.getOptions.mockClear()
    env.sidePanel.setOptions.mockClear()
    env.sidebarAction.getPanel.mockClear()
    env.sidebarAction.setPanel.mockClear()
    env.session.set.mockClear()
    await expect(env.side.getPath(target)).rejects.toBeInstanceOf(TypeError)
    await expect(env.side.setPath('other.html', target)).rejects.toBeInstanceOf(
      TypeError
    )
    expect(env.sidePanel.getOptions).not.toHaveBeenCalled()
    expect(env.sidePanel.setOptions).not.toHaveBeenCalled()
    expect(env.sidebarAction.getPanel).not.toHaveBeenCalled()
    expect(env.sidebarAction.setPanel).not.toHaveBeenCalled()
    expect(env.session.set).not.toHaveBeenCalled()
    expect(env.state()).toEqual(state)
  }
)

test('Chrome the background path message receiver also rejects both IDs', async () => {
  const env = await setup()
  const popup = create(
    { ...env.api, runtime: { ...env.api.runtime, ...env.bus.runtime() } },
    'popup'
  )
  const channel = popup.messaging.channel<{
    getPath: { request: SidePathTarget; response: string | undefined }
    setPath: {
      request: { path: string; target: SidePathTarget }
      response: undefined
    }
  }>('@midra/webext/side-paths')
  const target = { tabId: 11, windowId: 10 }
  const getting = channel.send('getPath', target)
  await expect(getting).rejects.toBeInstanceOf(RemoteError)
  await expect(getting).rejects.toMatchObject({ remoteName: 'TypeError' })
  await expect(
    channel.send('setPath', { path: 'other.html', target })
  ).rejects.toMatchObject({ remoteName: 'TypeError' })
  expect(env.state()).toBeUndefined()
  expect(env.sidePanel.setOptions).not.toHaveBeenCalled()
})

test('Chrome explicit window close closes every local panel and the global panel only in that window', async () => {
  const env = await setup()
  await env.side.setPath('window-a.html', { windowId: 10 })
  await env.side.setPath('window-b.html', { windowId: 20 })
  await env.side.setPath('tab.html', { tabId: 11 })
  const before = env.state()
  const options = [...env.tabOptions]
  const target = Object.freeze({ windowId: 10 })
  await env.side.close(target)
  expect(env.sidePanel.close.mock.calls).toEqual([
    [{ tabId: 11 }],
    [{ tabId: 12 }],
    [{ windowId: 10 }],
  ])
  expect(env.state()).toEqual(before)
  expect([...env.tabOptions]).toEqual(options)
  expect(env.globalOptions.path).toBe('global.html')
})

const unavailablePanels: { label: string; options: PanelOptions }[] = [
  { label: 'disabled', options: { path: 'disabled.html', enabled: false } },
  { label: 'missing path', options: {} },
  { label: 'empty path', options: { path: '' } },
]

test.each(unavailablePanels)(
  'Chrome window close skips a $label local panel and still closes subsequent local and global panels',
  async ({ options }) => {
    const env = await setup()
    env.tabOptions.set(11, { ...options })
    env.tabOptions.set(12, { path: 'local.html' })
    await env.side.close({ windowId: 10 })
    expect(env.sidePanel.close.mock.calls).toEqual([
      [{ tabId: 12 }],
      [{ windowId: 10 }],
    ])
    expect(env.tabOptions.get(11)).toEqual(options)
    expect(env.tabOptions.get(12)).toEqual({ path: 'local.html' })
  }
)

test.each(unavailablePanels)(
  'Chrome window close closes local panels but skips a $label global panel',
  async ({ options }) => {
    const env = await setup()
    env.globalOptions.path = options.path
    env.globalOptions.enabled = options.enabled
    env.tabOptions.set(11, { path: 'local-a.html', enabled: true })
    env.tabOptions.set(12, { path: 'local-b.html' })
    await env.side.close({ windowId: 10 })
    expect(env.sidePanel.close.mock.calls).toEqual([
      [{ tabId: 11 }],
      [{ tabId: 12 }],
    ])
    expect(env.sidePanel.getOptions).toHaveBeenLastCalledWith({})
    expect(env.globalOptions.path).toBe(options.path)
    expect(env.globalOptions.enabled).toBe(options.enabled)
  }
)

test.each(['getOptions', 'local close', 'global close'] as const)(
  'Chrome window close still propagates unrelated native %s errors',
  async (operation) => {
    const env = await setup()
    env.tabOptions.set(11, { path: 'local-a.html' })
    env.tabOptions.set(12, { path: 'local-b.html' })
    const failure = new Error(`Native ${operation} failed`)
    const fail = async () => {
      throw failure
    }
    if (operation === 'getOptions')
      env.sidePanel.getOptions.mockImplementationOnce(fail)
    else if (operation === 'local close')
      env.sidePanel.close.mockImplementationOnce(fail)
    else
      env.sidePanel.close.mockImplementation(async (target) => {
        if (target.windowId !== undefined) throw failure
      })

    await expect(env.side.close({ windowId: 10 })).rejects.toBe(failure)
    expect(env.sidePanel.close.mock.calls).toEqual(
      operation === 'getOptions'
        ? []
        : operation === 'local close'
          ? [[{ tabId: 11 }]]
          : [[{ tabId: 11 }], [{ tabId: 12 }], [{ windowId: 10 }]]
    )
  }
)

test.each([undefined, -2])(
  'Chrome close current window (%s) resolves the actual ID and includes tab-local panels',
  async (windowId) => {
    const env = await setup()
    env.setCurrentWindow(20)
    env.tabOptions.set(21, { path: 'native.html' })
    await env.side.close(
      windowId === undefined ? undefined : Object.freeze({ windowId })
    )
    expect(env.windows.getCurrent).toHaveBeenCalled()
    expect(env.sidePanel.close.mock.calls).toEqual([
      [{ tabId: 21 }],
      [{ windowId: 20 }],
    ])
  }
)

test('Chrome tab close distinguishes native tab-local options from global fallback', async () => {
  const env = await setup()
  await env.side.close({ tabId: 12 })
  expect(env.sidePanel.close).toHaveBeenLastCalledWith({ windowId: 10 })
  env.tabOptions.set(11, { path: 'native.html' })
  await env.side.close(Object.freeze({ tabId: 11 }))
  expect(env.sidePanel.close).toHaveBeenLastCalledWith({ tabId: 11 })
  await env.side.setPath('window.html', { windowId: 20 })
  await env.side.close({ tabId: 22 })
  expect(env.sidePanel.close).toHaveBeenLastCalledWith({ tabId: 22 })
  expect(env.sidePanel.close).toHaveBeenCalledTimes(3)
})

test.each(['global fallback', 'tab-local'] as const)(
  'Chrome tab close rejects a mismatched explicit window for a %s panel before native close',
  async (scope) => {
    const env = await setup()
    if (scope === 'tab-local') env.tabOptions.set(11, { path: 'local.html' })
    await expect(
      env.side.close(Object.freeze({ tabId: 11, windowId: 20 }))
    ).rejects.toBeInstanceOf(TypeError)
    expect(env.sidePanel.close).not.toHaveBeenCalled()
  }
)

test.each(['global fallback', 'tab-local'] as const)(
  'Chrome tab close resolves windowId -2 before validating a %s panel target',
  async (scope) => {
    const env = await setup()
    if (scope === 'tab-local') env.tabOptions.set(11, { path: 'local.html' })
    const target = Object.freeze({ tabId: 11, windowId: -2 })
    await env.side.close(target)
    expect(env.windows.getCurrent).toHaveBeenCalledTimes(1)
    expect(env.sidePanel.close.mock.calls).toEqual([
      [scope === 'tab-local' ? { tabId: 11, windowId: 10 } : { windowId: 10 }],
    ])

    env.setCurrentWindow(20)
    env.sidePanel.close.mockClear()
    env.windows.getCurrent.mockClear()
    await expect(env.side.close(target)).rejects.toBeInstanceOf(TypeError)
    expect(env.windows.getCurrent).toHaveBeenCalledTimes(1)
    expect(env.sidePanel.close).not.toHaveBeenCalled()
    expect(target).toEqual({ tabId: 11, windowId: -2 })
  }
)

test('Chrome isOpen returns false for an inactive tab without querying contexts', async () => {
  const env = await setup()
  env.setContexts([
    { windowId: 10, tabId: 12 },
    { windowId: 10, tabId: -1 },
  ])
  expect(await env.side.isOpen({ tabId: 12 })).toBe(false)
  expect(env.api.runtime.getContexts).not.toHaveBeenCalled()
})

test.each([
  { tabId: 11, expected: true },
  { tabId: 12, expected: false },
  { tabId: -1, expected: true },
  { tabId: undefined, expected: true },
])(
  'Chrome isOpen checks active tab against context tabId=$tabId',
  async ({ tabId, expected }) => {
    const env = await setup()
    env.setContexts([
      { windowId: 10, ...(tabId === undefined ? {} : { tabId }) },
    ])
    expect(await env.side.isOpen({ tabId: 11 })).toBe(expected)
    expect(await env.side.isOpen({ windowId: 10 })).toBe(expected)
    expect(env.api.runtime.getContexts).toHaveBeenLastCalledWith({
      contextTypes: ['SIDE_PANEL'],
      windowIds: [10],
    })
    expect(env.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 10 })
  }
)

test('Chrome isOpen scopes contexts to the current or explicit window and rejects mismatched active tab targets', async () => {
  const env = await setup()
  env.setContexts([{ windowId: 20, tabId: 21 }])
  expect(await env.side.isOpen()).toBe(false)
  expect(await env.side.isOpen({ windowId: -2 })).toBe(false)
  expect(await env.side.isOpen({ windowId: 20 })).toBe(true)
  await expect(
    env.side.isOpen({ tabId: 11, windowId: 20 })
  ).rejects.toBeInstanceOf(TypeError)
  env.tabState.get(21)!.active = false
  expect(await env.side.isOpen({ windowId: 20 })).toBe(false)
  env.setContexts([])
  expect(await env.side.isOpen({ tabId: 11 })).toBe(false)
})

test('Firefox window paths use native getPanel/setPanel with tab > window > global precedence', async () => {
  const env = await setup('firefox')
  expect(env.side.capabilities.windowPath).toBe(true)
  await env.side.setPath('moz-extension://test/ui/window-a.html?q=1#section', {
    windowId: 10,
  })
  expect(env.sidebarAction.setPanel).toHaveBeenLastCalledWith({
    windowId: 10,
    panel: '/ui/window-a.html?q=1#section',
  })
  expect(await env.side.getPath({ windowId: 10 })).toBe(
    'ui/window-a.html?q=1#section'
  )
  expect(env.sidebarAction.getPanel).toHaveBeenLastCalledWith({ windowId: 10 })
  await env.side.setPath('window-b.html', { windowId: 20 })
  await env.side.setPath('tab.html', { tabId: 11 })
  await env.side.setPath('global-new.html')
  expect(await env.side.getPath()).toBe('global-new.html')
  expect(await env.side.getPath({ tabId: 11 })).toBe('tab.html')
  expect(await env.side.getPath({ tabId: 12 })).toBe(
    'ui/window-a.html?q=1#section'
  )
  expect(await env.side.getPath({ tabId: 21 })).toBe('window-b.html')
  await env.side.setPath('window-a-new.html', { windowId: 10 })
  expect(await env.side.getPath({ tabId: 11 })).toBe('tab.html')
  expect(await env.side.getPath({ tabId: 22 })).toBe('window-b.html')
  env.setCurrentWindow(20)
  await env.side.setPath('/current.html', { windowId: -2 })
  expect(env.sidebarAction.setPanel).toHaveBeenLastCalledWith({
    windowId: -2,
    panel: '/current.html',
  })
  expect(await env.side.getPath({ windowId: -2 })).toBe('current.html')
  expect(env.sidebarAction.getPanel).toHaveBeenLastCalledWith({ windowId: -2 })
  expect(env.session.set).not.toHaveBeenCalled()
  for (const event of env.pathEvents) expect(event.listeners.size).toBe(0)
})

test.each([
  'getOptions',
  'setOptions',
  'tabs.get',
  'tabs.query',
  'session.get',
  'session.set',
  'getContexts',
  'close',
  'open',
] as const)(
  'Chrome propagates native %s errors without swallowing or replacing them',
  async (operation) => {
    const env = await setup()
    const failure = new Error(`Native ${operation} failed`)
    const fail = async () => {
      throw failure
    }
    let result: Promise<unknown>
    switch (operation) {
      case 'getOptions':
        env.sidePanel.getOptions.mockImplementationOnce(fail)
        result = env.side.getPath()
        break
      case 'setOptions':
        env.sidePanel.setOptions.mockImplementationOnce(fail)
        result = env.side.setPath('new.html')
        break
      case 'tabs.get':
        env.tabs.get.mockImplementationOnce(fail)
        result = env.side.getPath({ tabId: 11 })
        break
      case 'tabs.query':
        env.tabs.query.mockImplementationOnce(fail)
        result = env.side.setPath('new.html', { windowId: 10 })
        break
      case 'session.get':
        env.session.get.mockImplementationOnce(fail)
        result = env.side.getPath({ windowId: 10 })
        break
      case 'session.set':
        env.session.set.mockImplementationOnce(fail)
        result = env.side.setPath('new.html', { windowId: 10 })
        break
      case 'getContexts':
        env.api.runtime.getContexts.mockImplementationOnce(fail)
        result = env.side.isOpen({ windowId: 10 })
        break
      case 'close':
        env.sidePanel.close.mockImplementationOnce(fail)
        result = env.side.close({ windowId: 10 })
        break
      case 'open':
        env.sidePanel.open.mockImplementationOnce(fail)
        result = env.side.open({ tabId: 11 })
        break
    }
    await expect(result).rejects.toBe(failure)
    // A rejected queued operation must not block subsequent path requests.
    await env.side.getPath()
  }
)

test.each(['getPanel', 'setPanel'] as const)(
  'Firefox propagates native %s errors',
  async (operation) => {
    const env = await setup('firefox')
    const failure = new Error(`Native ${operation} failed`)
    const fail = async () => {
      throw failure
    }
    if (operation === 'getPanel') {
      env.sidebarAction.getPanel.mockImplementationOnce(fail)
      await expect(env.side.getPath({ windowId: 10 })).rejects.toBe(failure)
    } else {
      env.sidebarAction.setPanel.mockImplementationOnce(fail)
      await expect(env.side.setPath('new.html', { windowId: 10 })).rejects.toBe(
        failure
      )
    }
  }
)

test('Chrome native errors sent through the path bus preserve their remote name and message', async () => {
  const env = await setup()
  const popup = create(
    { ...env.api, runtime: { ...env.api.runtime, ...env.bus.runtime() } },
    'popup'
  )
  env.sidePanel.setOptions.mockImplementationOnce(async () => {
    throw new TypeError('Native path rejected')
  })
  const result = popup.side.setPath('new.html')
  await expect(result).rejects.toBeInstanceOf(RemoteError)
  await expect(result).rejects.toMatchObject({
    remoteName: 'TypeError',
    message: 'Native path rejected',
  })
})
