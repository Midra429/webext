import type Browser from 'webextension-polyfill'
import type {
  Handler,
  MainWorldMessaging,
  MainWorldOptions,
  MessageChannel,
  MessageDefinition,
  MessageSchema,
  MessageSender,
  Messaging,
  MessagingApi,
} from './types'

import { RemoteError, UnsupportedOperationError } from '../errors'
import { encode, normalizeError } from './serialization'
import { sendMessage } from './transport'
import { createWindowTransport, errorResponse } from './window'

export type {
  MainWorldBridgeOptions,
  MainWorldMessaging,
  MainWorldOptions,
  MessageChannel,
  MessageDefinition,
  MessageSchema,
  MessageSender,
  Messaging,
  MessagingApi,
  SendOptions,
} from './types'

export function createMessaging(
  api: MessagingApi,
  context?: string
): Messaging {
  return createFactory(api, context)
}

/**
 * 拡張APIがないMAIN worldで、同じ型付きchannel APIを作成します。
 * 同じフレームのコンテンツスクリプトでbridgeMainWorldを登録してください。
 * sendの既定宛先はbackground、target: 'content-script'で同じフレームへ送れます。
 * ページは通信を読み書きでき、namespaceやsenderは認証に使えません。
 */
export function createMainWorldMessaging(
  options: MainWorldOptions
): MainWorldMessaging {
  return createFactory(undefined, 'main-world', options)
}

function createFactory(
  api: MessagingApi | undefined,
  context?: string,
  mainOptions?: MainWorldOptions
): Messaging {
  const channels = new Map<string, MessageChannel<MessageSchema>>()
  const routes = new Map<string, Map<string, Handler>>()
  let listening = false
  let factoryDisposed = false
  let bridge: ReturnType<typeof createWindowTransport> | undefined
  let allowedChannels = new Set<string>()
  const route = (
    envelope: Record<string, unknown>,
    sender: MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    const handler = routes
      .get(envelope.channel as string)
      ?.get(envelope.type as string)
    if (!handler) return false
    // 権限要求などのユーザー操作に依存する処理のため、最初の await より前に
    // ハンドラーを同期的に呼び出します。応答は両ブラウザ共通のコールバック方式です。
    void (async () => {
      try {
        const result = await handler(
          envelope.empty === true ? undefined : envelope.payload,
          sender
        )
        sendResponse({
          __webext_rpc__: 1,
          ok: true,
          value: encode(result),
          empty: result === undefined,
        })
      } catch (error) {
        sendResponse({
          __webext_rpc__: 1,
          ok: false,
          error: normalizeError(error),
        })
      }
    })()
    return true
  }
  const main =
    mainOptions &&
    createWindowTransport(
      mainOptions,
      'main',
      (message, sender, _target, respond) => {
        if (!route(message, sender, respond))
          respond(
            errorResponse(
              new Error(`No receiver for ${message.channel}:${message.type}`)
            )
          )
      }
    )
  const listener = (
    message: unknown,
    sender: Browser.Runtime.MessageSender,
    sendResponse?: (response: unknown) => void
  ) => {
    if (!api || !sendResponse || !message || typeof message !== 'object')
      return false
    const envelope = message as Record<string, unknown>
    if (
      envelope.__webext_rpc__ !== 1 ||
      typeof envelope.channel !== 'string' ||
      typeof envelope.type !== 'string' ||
      sender.id !== api.runtime.id
    )
      return false
    if (envelope.target === 'main-world') {
      if (!bridge || !allowedChannels.has(envelope.channel)) return false
      relayToMain(envelope, sender, sendResponse)
      return true
    }
    return route(
      envelope,
      envelope.__webext_main_world__ === 1
        ? { ...sender, world: 'MAIN' }
        : sender,
      sendResponse
    )
  }
  const syncListener = () => {
    if (!api?.runtime.onMessage) return
    const needed = routes.size > 0 || !!bridge
    if (needed === listening) return
    if (needed) api.runtime.onMessage.addListener(listener)
    else api.runtime.onMessage.removeListener(listener)
    listening = needed
  }
  const relayToMain = (
    envelope: Record<string, unknown>,
    sender: MessageSender,
    respond: (response: unknown) => void
  ) => {
    const endpoint = bridge!
    void (async () => {
      try {
        const value = await sendMessage(
          undefined,
          envelope.channel as string,
          envelope.type as string,
          envelope.empty === true ? undefined : envelope.payload,
          { timeoutMs: envelope.timeoutMs as number | undefined },
          (message) => endpoint.send(message, sender)
        )
        respond({
          __webext_rpc__: 1,
          ok: true,
          value: encode(value),
          empty: value === undefined,
        })
      } catch (error) {
        const response = errorResponse(error)
        if (error instanceof RemoteError) response.error.name = error.remoteName
        respond(response)
      }
    })()
  }
  const removeRoute = (name: string, handlers: Map<string, Handler>) => {
    // 破棄済みチャンネルの stop が同名の新しいチャンネルを解除しないようにします。
    if (routes.get(name) !== handlers) return
    routes.delete(name)
    syncListener()
  }
  return {
    bridgeMainWorld(options) {
      if (factoryDisposed) throw new Error('Messaging is disposed')
      if (!api || context !== 'content-script')
        throw new UnsupportedOperationError(
          'messaging.bridgeMainWorld outside content-script'
        )
      if (bridge) throw new Error('A MAIN world bridge is already registered')
      if (
        !Array.isArray(options.channels) ||
        options.channels.some(
          (name) => typeof name !== 'string' || !name.trim()
        )
      )
        throw new TypeError(
          'MAIN world bridge channels must be non-empty names'
        )
      if (!api.runtime.onMessage)
        throw new UnsupportedOperationError('messaging.bridgeMainWorld')
      allowedChannels = new Set(options.channels)
      const endpoint = createWindowTransport(
        options,
        'content',
        (message, sender, target, respond) => {
          if (!allowedChannels.has(message.channel as string)) {
            respond(
              errorResponse(new Error('MAIN world channel is not allowed'))
            )
            return
          }
          if (target === 'content-script') {
            if (!route(message, sender, respond))
              respond(
                errorResponse(
                  new Error(
                    `No receiver for ${message.channel}:${message.type}`
                  )
                )
              )
          } else if (target === 'background') {
            // DOMから渡されたsender・target等は転送せず、runtimeが付ける実際のsenderを使います。
            void (async () => {
              try {
                respond(
                  await api.runtime.sendMessage({
                    __webext_rpc__: 1,
                    __webext_main_world__: 1,
                    channel: message.channel,
                    type: message.type,
                    payload: message.payload,
                    empty: message.empty,
                  })
                )
              } catch (error) {
                respond(errorResponse(error))
              }
            })()
          } else
            respond(
              errorResponse(new TypeError('Invalid MAIN world message target'))
            )
        }
      )
      bridge = endpoint
      syncListener()
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        endpoint.dispose()
        if (bridge === endpoint) {
          bridge = undefined
          allowedChannels.clear()
          syncListener()
        }
      }
    },
    channel<Schema extends { [K in keyof Schema]: MessageDefinition }>(
      name: string
    ): MessageChannel<Schema> {
      if (factoryDisposed) throw new Error('Messaging is disposed')
      if (!name.trim())
        throw new TypeError('Message channel name must not be empty')
      const cached = channels.get(name)
      if (cached) return cached as MessageChannel<Schema>
      const handlers = new Map<string, Handler>()
      let disposed = false
      const channel: MessageChannel<Schema> = {
        send(type, request, options = {}) {
          if (disposed)
            return Promise.reject(new Error('Message channel is disposed'))
          return sendMessage<Schema[typeof type]['response']>(
            api,
            name,
            type,
            request,
            options,
            main
              ? (message) => {
                  if (options.tabId !== undefined)
                    throw new TypeError('MAIN world cannot select another tab')
                  if (options.target === 'main-world')
                    throw new TypeError('MAIN world cannot send to itself')
                  return main.send(message, {}, options.target ?? 'background')
                }
              : options.target === 'main-world' && options.tabId === undefined
                ? (message) => {
                    if (!bridge || !allowedChannels.has(name))
                      throw new UnsupportedOperationError(
                        'messaging.send to MAIN world'
                      )
                    return bridge.send(message, {
                      id: api?.runtime.id,
                      url: bridge.window.location.href,
                    })
                  }
                : undefined
          )
        },
        handle(type, handler) {
          if (disposed) throw new Error('Message channel is disposed')
          if (handlers.has(type))
            throw new Error(
              `A handler for ${name}:${type} is already registered`
            )
          if (!main && !api?.runtime.onMessage)
            throw new UnsupportedOperationError('messaging.handle')
          handlers.set(type, handler as Handler)
          routes.set(name, handlers)
          syncListener()
          let stopped = false
          return () => {
            if (stopped) return
            stopped = true
            if (handlers.get(type) === handler) handlers.delete(type)
            if (!handlers.size) removeRoute(name, handlers)
          }
        },
        dispose() {
          if (disposed) return
          removeRoute(name, handlers)
          handlers.clear()
          disposed = true
          channels.delete(name)
        },
      }
      channels.set(name, channel as MessageChannel<MessageSchema>)
      return channel
    },
    dispose() {
      if (factoryDisposed) return
      factoryDisposed = true
      main?.dispose()
      bridge?.dispose()
      bridge = undefined
      allowedChannels.clear()
      for (const channel of channels.values()) channel.dispose()
      syncListener()
    },
  }
}
