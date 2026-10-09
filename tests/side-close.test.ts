import type { CreateWebExtOptions, WebExt } from '../src'

import { afterEach, expect, mock, test } from 'bun:test'

import { createWebExt } from '../src'

const instances = new Set<WebExt>()
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

afterEach(() => {
  for (const instance of instances) instance.dispose()
  instances.clear()
  if (originalWindow)
    Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function fixture() {
  type Listener = (
    message: unknown,
    sender: { id: string },
    respond: (value: unknown) => void
  ) => unknown
  const endpoints = new Set<Set<Listener>>()
  const openWindows = new Set<number>([10, 20])
  const documentCloses = new Map<number, ReturnType<typeof mock>>()
  const sidebarAction = {
    open: mock(async () => {}),
    close: mock(async () => {
      throw new Error('User gesture required')
    }),
    getPanel: mock(async () => 'moz-extension://test/side.html'),
    setPanel: mock(async () => {}),
    isOpen: mock(async ({ windowId }: { windowId?: number }) =>
      openWindows.has(windowId ?? 10)
    ),
  }
  function create(
    context: 'background' | 'sidepanel',
    windowId: number,
    options: {
      tab?: boolean
      iframe?: boolean
      popout?: boolean
      refusesClose?: boolean
    } = {}
  ) {
    const listeners = new Set<Listener>()
    endpoints.add(listeners)
    const runtime = {
      id: 'test',
      getURL: (path: string) =>
        `moz-extension://test/${path.startsWith('/') ? path.slice(1) : path}`,
      getManifest: () => ({ sidebar_action: { default_panel: 'side.html' } }),
      onMessage: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
      sendMessage: mock(
        (message: unknown) =>
          new Promise((resolve, reject) => {
            let handled = false
            for (const endpoint of endpoints) {
              if (endpoint === listeners) continue
              for (const listener of endpoint)
                if (listener(message, { id: 'test' }, resolve) === true)
                  handled = true
            }
            if (!handled) reject(new Error('No receiver'))
          })
      ),
    }
    const closeDocument = mock(() => {
      if (!options.refusesClose) openWindows.delete(windowId)
    })
    const documentWindow = { close: closeDocument, top: {} as unknown }
    if (!options.iframe) documentWindow.top = documentWindow
    if (context === 'sidepanel') {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: documentWindow,
      })
      documentCloses.set(windowId, closeDocument)
    }
    const api = {
      runtime,
      sidebarAction,
      tabs: {
        query: async () => [],
        getCurrent: async () =>
          options.tab ? { id: 99, windowId, active: true } : undefined,
        get: mock(async (tabId: number) => ({
          id: tabId,
          windowId: tabId === 21 ? 20 : 10,
          active: tabId !== 12,
        })),
      },
      windows: { getCurrent: mock(async () => ({ id: windowId })) },
    }
    const webext = createWebExt({
      api: api as unknown as CreateWebExtOptions['api'],
      context,
      url: `moz-extension://test/side.html${options.popout ? '?_webext_popout=1' : ''}`,
    })
    instances.add(webext)
    return { webext, runtime, listeners, api, closeDocument }
  }
  return { create, openWindows, documentCloses, sidebarAction }
}

async function initialized() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('Firefox background closes only the requested initialized sidebar without a user gesture', async () => {
  const f = fixture()
  const background = f.create('background', 10)
  const first = f.create('sidepanel', 10)
  const second = f.create('sidepanel', 20)
  await initialized()
  expect(background.webext.side.capabilities.backgroundClose).toBe('document')
  expect(first.listeners.size).toBe(1)
  expect(second.listeners.size).toBe(1)
  first.webext.initialize()
  expect(first.listeners.size).toBe(1)
  expect(await background.webext.side.isOpen({ windowId: 20 })).toBe(true)
  await background.webext.side.close({ windowId: 20 })
  expect(second.closeDocument).toHaveBeenCalledTimes(1)
  expect(first.closeDocument).not.toHaveBeenCalled()
  expect(f.sidebarAction.close).not.toHaveBeenCalled()
  expect(await background.webext.side.isOpen({ windowId: 20 })).toBe(false)
  expect(await background.webext.side.isOpen({ windowId: 10 })).toBe(true)
  await background.webext.side.close()
  expect(first.closeDocument).toHaveBeenCalledTimes(1)
})

test('Firefox tab close only affects an active tab in its own window; closed panels are no-ops', async () => {
  const f = fixture()
  const background = f.create('background', 10)
  const panel = f.create('sidepanel', 20)
  await initialized()
  await background.webext.side.close({ tabId: 12 })
  expect(panel.closeDocument).not.toHaveBeenCalled()
  expect(background.runtime.sendMessage).not.toHaveBeenCalled()
  await expect(
    background.webext.side.close({ tabId: 21, windowId: 10 })
  ).rejects.toThrow('does not belong')
  await background.webext.side.close({ tabId: 21 })
  expect(panel.closeDocument).toHaveBeenCalledTimes(1)
  await background.webext.side.close({ windowId: 20 })
  expect(panel.closeDocument).toHaveBeenCalledTimes(1)
})

test('Firefox sidebar can close itself without messaging its own context', async () => {
  const f = fixture()
  const panel = f.create('sidepanel', 10)
  await panel.webext.side.close()
  expect(panel.closeDocument).toHaveBeenCalledTimes(1)
  expect(panel.runtime.sendMessage).not.toHaveBeenCalled()
  expect(f.sidebarAction.close).not.toHaveBeenCalled()
})

test.each([{ tab: true }, { popout: true }, { iframe: true }])(
  'Firefox does not register a close receiver for non-sidebar documents: %j',
  async (options) => {
    const f = fixture()
    const background = f.create('background', 10)
    const page = f.create('sidepanel', 10, options)
    await initialized()
    expect(page.listeners.size).toBe(0)
    await expect(background.webext.side.close()).rejects.toThrow('No receiver')
    expect(page.closeDocument).not.toHaveBeenCalled()
  }
)

test('Firefox open uninitialized panels reject instead of pretending to close', async () => {
  const f = fixture()
  const background = f.create('background', 10)
  await expect(background.webext.side.close({ windowId: 20 })).rejects.toThrow(
    'No receiver'
  )
  expect(f.openWindows.has(20)).toBe(true)
  expect(f.sidebarAction.close).not.toHaveBeenCalled()
})

test('Firefox disposal removes its close receiver and prevents late asynchronous registration', async () => {
  const f = fixture()
  const panel = f.create('sidepanel', 10)
  panel.webext.dispose()
  await initialized()
  expect(panel.listeners.size).toBe(0)
  const second = f.create('sidepanel', 20)
  await initialized()
  expect(second.listeners.size).toBe(1)
  second.webext.dispose()
  second.webext.dispose()
  expect(second.listeners.size).toBe(0)
  expect(second.closeDocument).not.toHaveBeenCalled()
})

test('Firefox close waits for the actual closed state and reports a document that refuses to close', async () => {
  const f = fixture()
  const background = f.create('background', 10)
  const panel = f.create('sidepanel', 10, { refusesClose: true })
  await initialized()
  await expect(background.webext.side.close()).rejects.toThrow('did not close')
  expect(panel.closeDocument).toHaveBeenCalledTimes(1)
  expect(f.openWindows.has(10)).toBe(true)
})
