import type { PendingResponse } from './transport'
import type { MainWorldOptions, MessageSender } from './types'

import { UnsupportedOperationError } from '../errors'
import { encode, normalizeError } from './serialization'

type Side = 'main' | 'content'
type Receive = (
  message: Record<string, unknown>,
  sender: MessageSender,
  target: unknown,
  respond: (response: unknown) => void
) => void

export function errorResponse(error: unknown) {
  return { __webext_rpc__: 1, ok: false, error: normalizeError(error) }
}

/** 同じフレームのDOM通信。namespace・送信元worldはページから偽装でき、認証には使えません。 */
export function createWindowTransport(
  options: MainWorldOptions,
  side: Side,
  receive: Receive
) {
  if (typeof options.namespace !== 'string' || !options.namespace.trim())
    throw new TypeError('MAIN world namespace must not be empty')
  const namespace = options.namespace
  const window = options.window ?? globalThis.window
  if (!window?.postMessage || !window.addEventListener)
    throw new UnsupportedOperationError('MAIN world messaging')
  const origin = window.location.origin
  if (origin === 'null')
    throw new UnsupportedOperationError(
      'MAIN world messaging on opaque origins'
    )
  const peer: Side = side === 'main' ? 'content' : 'main'
  const pending = new Map<
    string,
    { resolve: (response: unknown) => void; reject: (error: unknown) => void }
  >()
  let disposed = false
  const post = (body: Record<string, unknown>) => {
    if (disposed) return
    window.postMessage(
      {
        ...body,
        __webext_window_rpc__: 1,
        namespace,
        from: side,
      },
      origin
    )
  }
  const listener = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== origin) return
    const data = event.data
    if (
      !data ||
      typeof data !== 'object' ||
      data.__webext_window_rpc__ !== 1 ||
      data.namespace !== namespace ||
      data.from !== peer ||
      typeof data.id !== 'string'
    )
      return
    if (data.kind === 'response') {
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      try {
        entry.resolve(encode(data.response))
      } catch (error) {
        entry.reject(error)
      }
      return
    }
    if (data.kind !== 'request') return
    const message = data.message
    if (
      !message ||
      typeof message !== 'object' ||
      message.__webext_rpc__ !== 1 ||
      typeof message.channel !== 'string' ||
      typeof message.type !== 'string' ||
      typeof message.empty !== 'boolean'
    )
      return
    const respond = (response: unknown) =>
      post({ kind: 'response', id: data.id, response })
    try {
      // DOM経由の値もネイティブ通信と同じJSON制約で検証します。
      const snapshot = encode(message) as Record<string, unknown>
      if (
        side === 'main' &&
        (!data.sender ||
          typeof data.sender !== 'object' ||
          Array.isArray(data.sender))
      )
        throw new TypeError('Invalid MAIN world message sender')
      const sender: MessageSender =
        side === 'content'
          ? { url: window.location.href, world: 'MAIN' }
          : (encode(data.sender) as MessageSender)
      receive(snapshot, sender, data.target, respond)
    } catch (error) {
      respond(errorResponse(error))
    }
  }
  window.addEventListener('message', listener)
  return {
    window,
    send(
      message: Record<string, unknown>,
      sender: MessageSender,
      target?: string
    ): PendingResponse {
      if (disposed) throw new Error('MAIN world messaging is disposed')
      // randomUUIDはsecure context限定なので、通常のHTTPページでも使えるAPIを使います。
      const id = Array.from(
        globalThis.crypto.getRandomValues(new Uint32Array(4)),
        (value) => value.toString(16)
      ).join('-')
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          post({ kind: 'request', id, message, sender: encode(sender), target })
        } catch (error) {
          pending.delete(id)
          reject(error)
        }
      })
      return {
        response,
        dispose: () => {
          pending.delete(id)
        },
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      window.removeEventListener('message', listener)
      for (const entry of pending.values())
        entry.reject(new Error('MAIN world messaging is disposed'))
      pending.clear()
    },
  }
}
