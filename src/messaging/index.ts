import type Browser from 'webextension-polyfill'
import type {
  Handler,
  MessageChannel,
  MessageDefinition,
  MessageSchema,
  Messaging,
  MessagingApi,
} from './types'

import { UnsupportedOperationError } from '../errors'
import { encode, normalizeError } from './serialization'
import { sendMessage } from './transport'

export type {
  MessageChannel,
  MessageDefinition,
  MessageSchema,
  Messaging,
  MessagingApi,
  SendOptions,
} from './types'

export function createMessaging(api: MessagingApi): Messaging {
  const channels = new Map<string, MessageChannel<MessageSchema>>()
  const routes = new Map<string, Map<string, Handler>>()
  let listening = false
  let factoryDisposed = false
  const listener = (
    message: unknown,
    sender: Browser.Runtime.MessageSender,
    sendResponse?: (response: unknown) => void
  ) => {
    if (!sendResponse || !message || typeof message !== 'object') return false
    const envelope = message as Record<string, unknown>
    if (
      envelope.__webext_rpc__ !== 1 ||
      typeof envelope.channel !== 'string' ||
      typeof envelope.type !== 'string' ||
      sender.id !== api.runtime.id
    )
      return false
    const handler = routes.get(envelope.channel)?.get(envelope.type)
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
  const removeRoute = (name: string, handlers: Map<string, Handler>) => {
    // 破棄済みチャンネルの stop が同名の新しいチャンネルを解除しないようにします。
    if (routes.get(name) !== handlers) return
    routes.delete(name)
    if (!routes.size && listening) {
      api.runtime.onMessage.removeListener(listener)
      listening = false
    }
  }
  return {
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
            options
          )
        },
        handle(type, handler) {
          if (disposed) throw new Error('Message channel is disposed')
          if (handlers.has(type))
            throw new Error(
              `A handler for ${name}:${type} is already registered`
            )
          if (!api.runtime.onMessage)
            throw new UnsupportedOperationError('messaging.handle')
          handlers.set(type, handler as Handler)
          routes.set(name, handlers)
          if (!listening) {
            api.runtime.onMessage.addListener(listener)
            listening = true
          }
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
      for (const channel of channels.values()) channel.dispose()
    },
  }
}
