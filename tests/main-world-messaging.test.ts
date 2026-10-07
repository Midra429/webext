import type { CreateWebExtOptions, MessageSender, SendOptions } from '../src'
import type { MessagingApi } from '../src/messaging'

import { expect, mock, test } from 'bun:test'

import {
  MessageTimeoutError,
  RemoteError,
  UnsupportedOperationError,
  createMainWorldMessaging,
  createWebExt,
} from '../src'
import { createMessaging } from '../src/messaging'
import { createWindowTransport } from '../src/messaging/window'

interface Schema {
  echo: { request: unknown; response: unknown }
}

test('failed bridge registration releases DOM listeners and permits retry', () => {
  const dom = page()
  const failure = new Error('Listener registration failed')
  const listeners = new Set<Listener>()
  const addListener = mock((listener: Listener) => {
    listeners.add(listener)
  })
  addListener.mockImplementationOnce(() => {
    throw failure
  })
  const messaging = createMessaging(
    {
      runtime: {
        id: 'test',
        sendMessage: mock(async () => undefined),
        onMessage: {
          addListener,
          removeListener: (listener: Listener) => listeners.delete(listener),
        },
      },
    } as unknown as MessagingApi,
    'content-script'
  )
  const options = { namespace: 'retry', channels: ['app'], window: dom.window }
  try {
    expect(() => messaging.bridgeMainWorld(options)).toThrow(failure)
    expect(dom.listeners.size).toBe(0)
    expect(listeners.size).toBe(0)
    const stop = messaging.bridgeMainWorld(options)
    expect(dom.listeners.size).toBe(1)
    expect(listeners.size).toBe(1)
    stop()
    stop()
    expect(dom.listeners.size).toBe(0)
    expect(listeners.size).toBe(0)
  } finally {
    messaging.dispose()
  }
})
type Listener = (
  message: unknown,
  sender: MessageSender,
  respond: (response: unknown) => void
) => boolean

function page() {
  const listeners = new Set<(event: MessageEvent) => void>()
  const window = {
    location: {
      href: 'https://example.com/page',
      origin: 'https://example.com',
    },
    addEventListener: (
      _name: string,
      listener: (event: MessageEvent) => void
    ) => {
      listeners.add(listener)
    },
    removeEventListener: (
      _name: string,
      listener: (event: MessageEvent) => void
    ) => {
      listeners.delete(listener)
    },
    postMessage: mock((data: unknown, origin: string) => {
      expect(origin).toBe(window.location.origin)
      const snapshot = structuredClone(data)
      queueMicrotask(() => emit(snapshot))
    }),
  }
  const emit = (
    data: unknown,
    source: unknown = window,
    origin = window.location.origin
  ) => {
    for (const listener of [...listeners])
      listener({ data, source, origin } as MessageEvent)
  }
  return {
    window: window as unknown as Window,
    emit,
    listeners,
    post: window.postMessage,
  }
}

function setup() {
  const dom = page()
  const backgroundListeners = new Set<Listener>()
  const contentListeners = new Set<Listener>()
  const dispatch = (
    listeners: Set<Listener>,
    message: unknown,
    sender: MessageSender
  ) =>
    new Promise<unknown>((resolve, reject) => {
      let handled = false
      for (const listener of listeners)
        if (listener(message, sender, resolve)) handled = true
      if (!handled) reject(new Error('No receiver'))
    })
  const runtime = (
    listeners: Set<Listener>,
    send: (message: unknown) => Promise<unknown>
  ) => ({
    id: 'test',
    onMessage: {
      addListener: (listener: Listener) => {
        listeners.add(listener)
      },
      removeListener: (listener: Listener) => {
        listeners.delete(listener)
      },
    },
    sendMessage: mock(send),
  })
  const contentRuntime = runtime(contentListeners, (message) =>
    dispatch(backgroundListeners, message, {
      id: 'test',
      url: dom.window.location.href,
      tab: {
        id: 12,
        index: 0,
        highlighted: false,
        active: true,
        incognito: false,
        pinned: false,
      },
      frameId: 2,
    })
  )
  const tabSend = mock(
    (
      tabId: number,
      message: unknown,
      target: { frameId?: number; documentId?: string }
    ) => {
      expect(tabId).toBe(12)
      expect(target).toEqual({ frameId: 2 })
      return dispatch(contentListeners, message, {
        id: 'test',
        url: 'chrome-extension://test/background.js',
      })
    }
  )
  const background = createMessaging(
    {
      runtime: runtime(backgroundListeners, (message) =>
        dispatch(contentListeners, message, { id: 'test' })
      ),
      tabs: { sendMessage: tabSend },
    } as unknown as MessagingApi,
    'background'
  )
  const contentWebExt = createWebExt({
    api: {
      runtime: {
        ...contentRuntime,
        getManifest: () => ({}),
        getURL: (path: string) => `chrome-extension://test${path}`,
      },
    } as unknown as CreateWebExtOptions['api'],
    context: 'content-script',
    url: dom.window.location.href,
  })
  const content = contentWebExt.messaging
  const options = { namespace: 'test/world', window: dom.window }
  const main = createMainWorldMessaging(options)
  const startBridge = () =>
    content.bridgeMainWorld({ ...options, channels: ['app'] })
  return {
    ...dom,
    background,
    content,
    main,
    options,
    startBridge,
    contentRuntime,
    tabSend,
    contentListeners,
    dispose() {
      main.dispose()
      contentWebExt.dispose()
      background.dispose()
    },
  }
}

test('MAIN world exchanges typed messages in all four directions with actual sender metadata', async () => {
  const env = setup()
  const main = env.main.channel<Schema>('app')
  const content = env.content.channel<Schema>('app')
  const background = env.background.channel<Schema>('app')
  const inContent = mock((request: unknown, sender: MessageSender) => ({
    request,
    sender,
    receiver: 'content',
  }))
  const inBackground = mock((request: unknown, sender: MessageSender) => ({
    request,
    sender,
    receiver: 'background',
  }))
  main.handle('echo', (request, sender) => ({
    request,
    sender,
    receiver: 'main',
  }))
  content.handle('echo', inContent)
  background.handle('echo', inBackground)
  env.startBridge()
  try {
    expect(
      await main.send('echo', 'to content', { target: 'content-script' })
    ).toEqual({
      request: 'to content',
      sender: { url: env.window.location.href, world: 'MAIN' },
      receiver: 'content',
    })
    expect(env.contentRuntime.sendMessage).not.toHaveBeenCalled()
    expect(await main.send('echo', 'to background')).toMatchObject({
      request: 'to background',
      receiver: 'background',
      sender: { id: 'test', tab: { id: 12 }, frameId: 2, world: 'MAIN' },
    })
    expect(
      await content.send('echo', 'from content', { target: 'main-world' })
    ).toMatchObject({
      request: 'from content',
      receiver: 'main',
      sender: { id: 'test', url: env.window.location.href },
    })
    expect(
      await background.send('echo', 'from background', {
        target: 'main-world',
        tabId: 12,
        frameId: 2,
      })
    ).toMatchObject({
      request: 'from background',
      receiver: 'main',
      sender: { id: 'test', url: 'chrome-extension://test/background.js' },
    })
    expect(inContent).toHaveBeenCalledTimes(1)
    expect(inBackground).toHaveBeenCalledTimes(1)
    expect(env.tabSend).toHaveBeenCalledTimes(1)
    // 通常のruntime通信にはMAIN由来の印を付けません。
    await content.send('echo', 'native')
    expect(inBackground.mock.calls[1]?.[1].world).toBeUndefined()
  } finally {
    env.dispose()
  }
  expect(env.listeners.size).toBe(0)
})

test('parallel MAIN world requests correlate out-of-order responses and preserve undefined', async () => {
  const env = setup()
  const replies: Array<() => void> = []
  env.main.channel<Schema>('app').handle(
    'echo',
    (value) =>
      new Promise((resolve) => {
        replies.push(() => resolve(value))
      })
  )
  const channel = env.content.channel<Schema>('app')
  env.startBridge()
  try {
    const first = channel.send('echo', 'first', { target: 'main-world' })
    const second = channel.send('echo', undefined, { target: 'main-world' })
    await new Promise((resolve) => queueMicrotask(resolve))
    replies[1]!()
    expect(await second).toBeUndefined()
    replies[0]!()
    expect(await first).toBe('first')
  } finally {
    env.dispose()
  }
})

test.each(['main', 'content', 'background'] as const)(
  'errors from %s retain remoteName through the bridge',
  async (receiver) => {
    const env = setup()
    env[receiver].channel<Schema>('app').handle('echo', () => {
      throw new TypeError('Invalid input')
    })
    env.startBridge()
    try {
      const response =
        receiver === 'main'
          ? env.background.channel<Schema>('app').send('echo', null, {
              target: 'main-world',
              tabId: 12,
              frameId: 2,
            })
          : env.main.channel<Schema>('app').send('echo', null, {
              target: receiver === 'content' ? 'content-script' : 'background',
            })
      await expect(response).rejects.toBeInstanceOf(RemoteError)
      await expect(response).rejects.toMatchObject({
        remoteName: 'TypeError',
        message: 'Invalid input',
      })
    } finally {
      env.dispose()
    }
  }
)

test('the bridge only exposes allowed channels and never forwards forged sender or routing fields', async () => {
  const env = setup()
  const secret = mock(() => 'private')
  env.background.channel<Schema>('private').handle('echo', secret)
  const receive = mock((_value: unknown, sender: MessageSender) => sender)
  env.background.channel<Schema>('app').handle('echo', receive)
  env.startBridge()
  try {
    await expect(
      env.main.channel<Schema>('private').send('echo', null)
    ).rejects.toThrow('not allowed')
    expect(secret).not.toHaveBeenCalled()
    expect(env.contentRuntime.sendMessage).not.toHaveBeenCalled()
    env.emit({
      __webext_window_rpc__: 1,
      namespace: env.options.namespace,
      from: 'main',
      kind: 'request',
      id: 'forged',
      target: 'background',
      sender: { id: 'evil', tab: { id: 99 } },
      message: {
        __webext_rpc__: 1,
        channel: 'app',
        type: 'echo',
        payload: null,
        empty: false,
        target: 'main-world',
        tabId: 99,
        __webext_main_world__: 0,
      },
    })
    expect(receive.mock.calls[0]?.[1]).toMatchObject({
      id: 'test',
      tab: { id: 12 },
      world: 'MAIN',
    })
    expect(env.contentRuntime.sendMessage.mock.calls[0]?.[0]).toEqual({
      __webext_rpc__: 1,
      __webext_main_world__: 1,
      channel: 'app',
      type: 'echo',
      payload: null,
      empty: false,
    })
  } finally {
    env.dispose()
  }
})

test('window transport ignores other frames, origins, namespaces and malformed requests', async () => {
  const dom = page()
  const receive = mock(() => {})
  const endpoint = createWindowTransport(
    { namespace: 'test', window: dom.window },
    'content',
    receive
  )
  const request = {
    __webext_window_rpc__: 1,
    namespace: 'test',
    from: 'main',
    kind: 'request',
    id: 'request',
    message: {
      __webext_rpc__: 1,
      channel: 'app',
      type: 'echo',
      payload: null,
      empty: false,
    },
  }
  try {
    dom.emit(request, {})
    dom.emit(request, dom.window, 'https://evil.example')
    dom.emit({ ...request, namespace: 'other' })
    dom.emit({ ...request, from: 'content' })
    dom.emit({ ...request, id: 5 })
    dom.emit({ ...request, message: { ...request.message, type: 5 } })
    expect(receive).not.toHaveBeenCalled()
    dom.emit(request)
    expect(receive).toHaveBeenCalledTimes(1)
  } finally {
    endpoint.dispose()
  }
})

test('window transport forgets cancelled requests and ignores their late responses', async () => {
  const dom = page()
  const endpoint = createWindowTransport(
    { namespace: 'test', window: dom.window },
    'main',
    () => {}
  )
  try {
    const cancelled = endpoint.send({}, {})
    let cancelledResolved = false
    void (async () => {
      await cancelled.response
      cancelledResolved = true
    })()
    const cancelledId = (dom.post.mock.calls[0]?.[0] as { id: string }).id
    cancelled.dispose()
    const next = endpoint.send({}, {})
    const nextId = (dom.post.mock.calls[1]?.[0] as { id: string }).id
    const reply = {
      __webext_window_rpc__: 1,
      namespace: 'test',
      from: 'content',
      kind: 'response',
      response: { __webext_rpc__: 1, ok: true, value: 'value' },
    }
    dom.emit({ ...reply, id: cancelledId })
    dom.emit({ ...reply, id: nextId })
    expect(await next.response).toEqual(reply.response)
    expect(cancelledResolved).toBe(false)
    next.dispose()
  } finally {
    endpoint.dispose()
  }
})

test.each(['main', 'content', 'background'] as const)(
  'non-JSON responses from %s fail as RemoteError',
  async (receiver) => {
    const env = setup()
    env[receiver].channel<Schema>('app').handle('echo', () => new Date())
    env.startBridge()
    try {
      const channel =
        receiver === 'main'
          ? env.content.channel<Schema>('app')
          : env.main.channel<Schema>('app')
      const target =
        receiver === 'main'
          ? 'main-world'
          : receiver === 'content'
            ? 'content-script'
            : 'background'
      await expect(
        channel.send('echo', null, { target })
      ).rejects.toMatchObject({ remoteName: 'TypeError' })
    } finally {
      env.dispose()
    }
  }
)

test('MAIN world timeouts, aborts and disposal clean up pending responses without affecting later requests', async () => {
  const env = setup()
  const channel = env.main.channel<Schema>('app')
  try {
    await expect(
      channel.send('echo', null, { timeoutMs: 5 })
    ).rejects.toBeInstanceOf(MessageTimeoutError)
    const controller = new AbortController()
    const response = channel.send('echo', null, { signal: controller.signal })
    controller.abort(new Error('Cancelled'))
    await expect(response).rejects.toThrow('Cancelled')
    const posts = env.post.mock.calls.length
    await expect(
      channel.send('echo', null, { signal: controller.signal })
    ).rejects.toThrow('Cancelled')
    expect(env.post.mock.calls.length).toBe(posts)
    env.startBridge()
    env.background.channel<Schema>('app').handle('echo', (value) => value)
    expect(await channel.send('echo', 'later')).toBe('later')
    // MAINの破棄はDOM通信の未完了待機を拒否します。
    const waiting = channel.send('echo', null)
    env.main.dispose()
    await expect(waiting).rejects.toThrow('disposed')
  } finally {
    env.dispose()
  }
  expect(env.listeners.size).toBe(0)
})

test('bridge stops are idempotent and do not remove handlers or a later bridge', async () => {
  const env = setup()
  const channel = env.content.channel<Schema>('app')
  const stopHandler = channel.handle('echo', (value) => value)
  const stop = env.startBridge()
  expect(env.contentListeners.size).toBe(1)
  try {
    expect(() => env.startBridge()).toThrow('already registered')
    stop()
    stop()
    expect(env.listeners.size).toBe(1)
    expect(env.contentListeners.size).toBe(1)
    env.startBridge()
    stop()
    expect(
      await env.main
        .channel<Schema>('app')
        .send('echo', 'alive', { target: 'content-script' })
    ).toBe('alive')
    env.content.dispose()
    expect(env.contentListeners.size).toBe(0)
    stopHandler()
    expect(env.contentListeners.size).toBe(0)
    expect(env.listeners.size).toBe(1)
  } finally {
    env.dispose()
  }
})

test('unsupported environments, routes and non-JSON values fail before sending', async () => {
  const env = setup()
  try {
    expect(() =>
      createMainWorldMessaging({ ...env.options, namespace: ' ' })
    ).toThrow(TypeError)
    expect(() =>
      createMainWorldMessaging({ ...env.options, window: undefined })
    ).toThrow(UnsupportedOperationError)
    expect(() =>
      env.background.bridgeMainWorld({ ...env.options, channels: ['app'] })
    ).toThrow(UnsupportedOperationError)
    env.startBridge()
    const channel = env.main.channel<Schema>('app')
    for (const options of [
      { tabId: 12 },
      { target: 'main-world' },
      { frameId: 2 },
      { target: 'bad' },
      { timeoutMs: 0 },
    ] as SendOptions[]) {
      await expect(channel.send('echo', null, options)).rejects.toBeInstanceOf(
        TypeError
      )
    }
    await expect(channel.send('echo', new Map())).rejects.toBeInstanceOf(
      TypeError
    )
    expect(env.post).not.toHaveBeenCalled()
    await expect(
      env.background
        .channel<Schema>('app')
        .send('echo', null, { target: 'main-world' })
    ).rejects.toBeInstanceOf(UnsupportedOperationError)
  } finally {
    env.dispose()
  }
})
