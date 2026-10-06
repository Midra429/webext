import type { CreateWebExtOptions } from '../src'

import { expect, mock, test } from 'bun:test'

import { UnsupportedOperationError, createWebExt } from '../src'

function native(protocol = 'chrome-extension:') {
  return {
    runtime: {
      getManifest: () => ({ action: { default_popup: 'ui/popup.html' } }),
      getURL: (path: string) =>
        `${protocol}//test/${path.startsWith('/') ? path.slice(1) : path}`,
    },
    tabs: {
      query: mock(async () => [{ id: 7 }]),
      get: mock(async (id: number) => ({ id })),
    },
    windows: { create: mock(async (options: unknown) => options) },
    storage: { local: { get: mock(async () => ({ greeting: '日本語' })) } },
  }
}

function create(api: unknown, url?: string) {
  return createWebExt({ api: api as CreateWebExtOptions['api'], url })
}

test('active tab and linked target are separate; import does not mutate native APIs', async () => {
  const api = native()
  const webext = create(
    api,
    'chrome-extension://test/ui/popup.html?_webext_linked_tab_id=12'
  )
  expect(await webext.tabs.getCurrentActiveId()).toBe(7)
  expect(await webext.tabs.getTargetId()).toBe(12)
  expect(webext.context.type).toBe('popup')
  expect('getTarget' in api.tabs).toBe(false)
  expect('context' in api).toBe(false)
  expect(await create(api).tabs.getTargetId()).toBe(7)
  expect(Object.keys(webext)).toContain('side')
  expect(Object.getOwnPropertyDescriptor(webext, 'side')?.value).toBe(
    webext.side
  )
})

test('content scripts need no tabs API and do not trust page query parameters', () => {
  const { runtime } = native()
  const webext = create(
    { runtime },
    'https://example.org/?_webext_linked_tab_id=12'
  )
  expect(webext.context.type).toBe('content-script')
  expect(webext.context.linkedTabId).toBeNull()
  expect(webext.context.isPopout).toBe(false)
  expect(webext.side.available).toBe(false)
})

test('Chrome side forwards immediately, preserves options and native methods', async () => {
  const sidePanel = {
    open: mock(async (_options: unknown) => {}),
    close: mock(async (_options: unknown) => {}),
    getOptions: mock(async () => ({ path: 'side.html' })),
    setOptions: mock(async (_options: unknown) => {}),
  }
  const api = native()
  const getContexts = mock(async (_filter: unknown) => [{ windowId: 42 }])
  const webext = create({
    ...api,
    sidePanel,
    runtime: { ...api.runtime, getContexts },
    windows: { ...api.windows, getCurrent: async () => ({ id: 42 }) },
  })
  expect(webext.side.capabilities.isOpen).toBe('document')
  expect(await webext.side.isOpen()).toBe(true)
  expect(getContexts).toHaveBeenCalledWith({
    contextTypes: ['SIDE_PANEL'],
    windowIds: [42],
  })
  const target = Object.freeze({ windowId: 42 })
  const opening = webext.side.open(target)
  expect(sidePanel.open).toHaveBeenCalledWith({ windowId: 42 })
  expect(sidePanel.setOptions).not.toHaveBeenCalled()
  await opening
  await webext.side.open()
  expect(sidePanel.open).toHaveBeenLastCalledWith({ windowId: -2 })
  await webext.side.close(target)
  expect(sidePanel.close).toHaveBeenCalledWith(target)
  await webext.side.close()
  expect(sidePanel.close).toHaveBeenLastCalledWith({ windowId: 42 })
  expect(Object.is(webext.sidePanel, sidePanel)).toBe(true)
  await webext.side.setPath('other.html')
  expect(sidePanel.setOptions).toHaveBeenCalledWith({ path: 'other.html' })
})

test('Firefox side maps native paths and opens synchronously; popout preserves URL components', async () => {
  const api = native('moz-extension:')
  const sidebarAction = {
    open: mock(async () => {}),
    close: mock(async () => {}),
    getPanel: mock(
      async () => 'moz-extension://test/ui/side.html?theme=dark#section'
    ),
    setPanel: mock(async (_options: unknown) => {}),
  }
  const webext = create({ ...api, sidebarAction })
  const opening = webext.side.open()
  expect(sidebarAction.open).toHaveBeenCalledTimes(1)
  await opening
  expect(await webext.side.getPath()).toBe('ui/side.html?theme=dark#section')
  await webext.side.setPath('new.html', { tabId: 7 })
  expect(sidebarAction.setPanel).toHaveBeenCalledWith({
    panel: '/new.html',
    tabId: 7,
  })
  await webext.side.openPopout({ width: 400 })
  expect(api.windows.create).toHaveBeenCalledWith({
    width: 400,
    type: 'popup',
    url: 'moz-extension://test/ui/side.html?theme=dark&_webext_popout=1&_webext_linked_tab_id=7#section',
  })
  expect(sidebarAction.getPanel).toHaveBeenCalledWith({ tabId: 7 })
  await webext.side.openPopout({ tabId: null })
  const unlinked = api.windows.create.mock.calls.at(-1)?.[0] as { url: string }
  const popout = create(api, unlinked.url)
  expect(popout.context.linkedTabId).toBeNull()
  expect(popout.context.isPopout).toBe(true)
  await expect(
    create({ ...api, action: { getPopup: async () => '' } }).action.openPopout({
      tabId: null,
    })
  ).rejects.toThrow('No action popup')
  await expect(webext.side.open({ windowId: 42 })).rejects.toBeInstanceOf(
    UnsupportedOperationError
  )
  await webext.side.close()
  expect(sidebarAction.close).toHaveBeenCalledTimes(1)
})

test('Firefox side paths resolve from the extension root even for nested callers', async () => {
  const caller = 'moz-extension://test/ui/popup.html'
  let resolved = ''
  const sidebarAction = {
    setPanel: mock(async ({ panel }: { panel: string }) => {
      resolved = new URL(panel, caller).href
    }),
  }
  const webext = create({ ...native('moz-extension:'), sidebarAction }, caller)
  const expected = 'moz-extension://test/ui/side.html?theme=dark#section'
  for (const path of [
    'ui/side.html?theme=dark#section',
    '/ui/side.html?theme=dark#section',
    expected,
  ]) {
    await webext.side.setPath(path, { tabId: 7 })
    expect(resolved).toBe(expected)
    expect(sidebarAction.setPanel).toHaveBeenLastCalledWith({
      panel: '/ui/side.html?theme=dark#section',
      tabId: 7,
    })
  }
  await webext.side.setPath('side.html')
  expect(resolved).toBe('moz-extension://test/side.html')
  expect(sidebarAction.setPanel).toHaveBeenLastCalledWith({
    panel: '/side.html',
  })
  const calls = sidebarAction.setPanel.mock.calls.length
  await expect(
    webext.side.setPath('https://example.org/side.html')
  ).rejects.toBeInstanceOf(TypeError)
  expect(sidebarAction.setPanel.mock.calls.length).toBe(calls)
})

test.each([
  'moz-extension://test/ui:side.html?q=1#section',
  'moz-extension://test//other/side.html?q=1#section',
])(
  'special panel paths keep their validated destination after normalization: %s',
  async (expected) => {
    const api = native('moz-extension:')
    const caller = 'moz-extension://test/ui/popup.html'
    let configured: string = expected
    const sidebarAction = {
      getPanel: mock(async () => configured),
      setPanel: mock(async ({ panel }: { panel: string }) => {
        configured = new URL(panel, caller).href
      }),
    }
    const webext = create({ ...api, sidebarAction }, caller)
    const relative = await webext.side.getPath()
    expect(relative).toBeDefined()
    expect(new URL(relative!, api.runtime.getURL('/')).href).toBe(expected)
    await webext.side.setPath(relative!)
    expect(configured).toBe(expected)
    await webext.side.openPopout({ tabId: null })
    const options = api.windows.create.mock.calls[0]?.[0] as { url: string }
    const actual = new URL(options.url)
    expect(actual.host).toBe('test')
    expect(actual.pathname).toBe(new URL(expected).pathname)
    expect(actual.searchParams.get('q')).toBe('1')
    expect(actual.hash).toBe('#section')
  }
)

test('action popouts query the target only for an omitted tab ID', async () => {
  const api = native()
  const getPopup = mock(
    async (_details: unknown) => 'ui/popup.html?theme=dark#section'
  )
  const webext = create({ ...api, action: { getPopup } })
  await webext.action.openPopout()
  expect(api.tabs.query).toHaveBeenCalledTimes(1)
  expect(getPopup).toHaveBeenLastCalledWith({ tabId: 7 })
  await webext.action.openPopout({ tabId: 12 })
  expect(api.tabs.query).toHaveBeenCalledTimes(1)
  expect(getPopup).toHaveBeenLastCalledWith({ tabId: 12 })
  await webext.action.openPopout({ tabId: null })
  expect(api.tabs.query).toHaveBeenCalledTimes(1)
  expect(getPopup).toHaveBeenLastCalledWith({})
})

test('closed linked targets propagate errors instead of selecting an active fallback', async () => {
  const api = native()
  const failure = new Error('Linked tab has closed')
  const get = mock(async (_id: number) => {
    throw failure
  })
  const getPopup = mock(async () => 'ui/popup.html')
  const getOptions = mock(async () => ({ path: 'ui/side.html' }))
  const webext = create(
    {
      ...api,
      tabs: { ...api.tabs, get },
      action: { getPopup },
      sidePanel: { getOptions },
    },
    'chrome-extension://test/ui/popup.html?_webext_linked_tab_id=12'
  )
  await expect(webext.tabs.getTarget()).rejects.toBe(failure)
  await expect(webext.action.openPopout()).rejects.toBe(failure)
  await expect(webext.side.openPopout()).rejects.toBe(failure)
  expect(get).toHaveBeenCalledTimes(3)
  expect(api.tabs.query).not.toHaveBeenCalled()
  expect(api.windows.create).not.toHaveBeenCalled()
  expect(getPopup).not.toHaveBeenCalled()
  expect(getOptions).not.toHaveBeenCalled()
})

test('popouts resolve an omitted target once even when there is no active tab', async () => {
  const api = native()
  const query = mock(async () => [])
  const getOptions = mock(async () => ({
    path: 'ui/side.html?theme=dark#section',
  }))
  const webext = create({
    ...api,
    tabs: { ...api.tabs, query },
    sidePanel: { getOptions },
  })
  await webext.side.openPopout({ width: 400 })
  expect(query).toHaveBeenCalledTimes(1)
  expect(getOptions).toHaveBeenCalledWith({})
  expect(api.windows.create).toHaveBeenCalledWith({
    width: 400,
    type: 'popup',
    url: 'chrome-extension://test/ui/side.html?theme=dark&_webext_popout=1#section',
  })
  await webext.side.openPopout({ tabId: null })
  expect(query).toHaveBeenCalledTimes(1)
})

test('explicit contexts skip automatic manifest inspection and preserve internal query safety', () => {
  const api = native()
  const getManifest = mock(() => {
    throw new Error('No manifest lookup needed')
  })
  const webext = createWebExt({
    api: {
      ...api,
      runtime: { ...api.runtime, getManifest },
    } as unknown as CreateWebExtOptions['api'],
    context: null,
    browser: 'unknown',
    url: 'chrome-extension://test/ui/custom.html?_webext_popout=1&_webext_linked_tab_id=invalid',
  })
  expect(webext.context.type).toBeNull()
  expect(webext.context.browser).toBe('unknown')
  expect(webext.context.isPopout).toBe(true)
  expect(webext.context.linkedTabId).toBeNull()
  expect(getManifest).not.toHaveBeenCalled()
  const foreign = create(
    api,
    'chrome-extension://other/ui/popup.html?_webext_linked_tab_id=7'
  )
  expect(foreign.context.type).toBe('content-script')
  expect(foreign.context.linkedTabId).toBeNull()
})

test('action click bindings unregister once and keep native opening in the click stack', async () => {
  const api = native()
  const listeners = new Set<(tab: { windowId: number }) => void>()
  const removeListener = mock(
    (listener: (tab: { windowId: number }) => void) => {
      listeners.delete(listener)
    }
  )
  const open = mock(async (_options: unknown) => {})
  const webext = create({
    ...api,
    sidePanel: { open },
    action: {
      onClicked: {
        addListener: (listener: (tab: { windowId: number }) => void) => {
          listeners.add(listener)
        },
        removeListener,
      },
    },
  })
  const onError = mock((_error: unknown) => {})
  const stop = webext.side.bindActionClick(onError)
  const listener = [...listeners][0]!
  listener({ windowId: 42 })
  expect(open).toHaveBeenCalledWith({ windowId: 42 })
  stop()
  stop()
  webext.dispose()
  expect(listeners.size).toBe(0)
  expect(removeListener).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(onError).not.toHaveBeenCalled()
})

test('background initialization and instance cleanup preserve unrelated native listeners', () => {
  const api = native()
  function event() {
    const unrelated = () => {}
    const listeners = new Set<unknown>([unrelated])
    return {
      listeners,
      unrelated,
      addListener: mock((listener: unknown) => {
        listeners.add(listener)
      }),
      removeListener: mock((listener: unknown) => {
        listeners.delete(listener)
      }),
    }
  }
  const messages = event()
  const clicks = event()
  const changes = event()
  const webext = createWebExt({
    context: 'background',
    api: {
      ...api,
      runtime: { ...api.runtime, onMessage: messages },
      action: { onClicked: clicks },
      sidePanel: { open: async () => {} },
      storage: { ...api.storage, onChanged: changes },
    } as unknown as CreateWebExtOptions['api'],
  })
  expect(messages.addListener).toHaveBeenCalledTimes(1)
  webext.initialize()
  webext.initialize()
  webext.messaging
    .channel<{ event: { request: null; response: null } }>('app')
    .handle('event', () => null)
  expect(messages.addListener).toHaveBeenCalledTimes(1)
  const stopWatch = webext.storage.local.watch('theme', () => {})
  const stopClick = webext.side.bindActionClick(() => {})
  webext.dispose()
  webext.dispose()
  stopWatch()
  stopClick()
  for (const source of [messages, clicks, changes]) {
    expect(source.removeListener).toHaveBeenCalledTimes(1)
    expect([...source.listeners]).toEqual([source.unrelated])
  }
})

test('missing methods reject explicitly; storage supplements only missing functions', async () => {
  const api = native()
  const webext = create(api)
  await expect(webext.side.close()).rejects.toBeInstanceOf(
    UnsupportedOperationError
  )
  expect(await webext.storage.local.getValue('greeting', '')).toBe('日本語')
  expect(await webext.storage.local.getValue('missing', 'default')).toBe(
    'default'
  )
  expect(await webext.storage.local.getKeys()).toEqual(['greeting'])
  expect(await webext.storage.local.getBytesInUse()).toBe(19)
  expect('getBytesInUse' in api.storage.local).toBe(false)
  const getBytesInUse = mock(async () => 123)
  const getKeys = mock(async () => ['native'])
  const area = { ...api.storage.local, getBytesInUse, getKeys }
  const wrapped = create({
    ...api,
    storage: { local: area, sync: area, session: area },
  })
  expect(await wrapped.storage.local.getBytesInUse()).toBe(123)
  expect(await wrapped.storage.local.getKeys()).toEqual(['native'])
  expect(await wrapped.storage.sync.getKeys()).toEqual(['native'])
  expect(await wrapped.storage.session?.getBytesInUse()).toBe(123)
  expect(wrapped.storage.local.capabilities.getBytesInUse).toBe('native')
  expect(webext.storage.local.capabilities.getBytesInUse).toBe('estimated')
})
