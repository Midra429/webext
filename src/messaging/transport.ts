import type { MessagingApi, SendOptions } from './types'

import {
  MessageTimeoutError,
  RemoteError,
  UnsupportedOperationError,
  assertTabId,
} from '../errors'
import { encode } from './serialization'

const MAX_TIMEOUT_MS = 2_147_483_647

export interface PendingResponse {
  response: Promise<unknown>
  dispose(): void
}

export type RequestTransport = (
  message: Record<string, unknown>
) => PendingResponse

export async function sendMessage<Response>(
  api: MessagingApi | undefined,
  name: string,
  type: string,
  request: unknown,
  options: SendOptions = {},
  transport?: RequestTransport
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const signal = options.signal
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be positive, finite and at most ${MAX_TIMEOUT_MS}`
    )
  }
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (options.tabId !== undefined) assertTabId(options.tabId)
  if (
    options.tabId === undefined &&
    (options.frameId !== undefined || options.documentId !== undefined)
  ) {
    throw new TypeError('frameId/documentId requires tabId')
  }
  if (
    options.target !== undefined &&
    !['background', 'content-script', 'main-world'].includes(options.target)
  )
    throw new TypeError('Invalid message target')
  if (options.target === 'background' && options.tabId !== undefined)
    throw new TypeError('background target cannot be combined with tabId')
  const message = {
    __webext_rpc__: 1,
    channel: name,
    type,
    payload: encode(request),
    empty: request === undefined,
    ...(options.target === 'main-world'
      ? { target: 'main-world', timeoutMs }
      : {}),
  }
  let pending: PendingResponse | undefined
  const send = () => {
    if (transport) {
      pending = transport(message)
      return pending.response
    }
    if (!api) throw new UnsupportedOperationError('messaging.send')
    if (options.target === 'content-script' && options.tabId === undefined)
      throw new TypeError('content-script target requires tabId')
    // メソッドを所有オブジェクト経由で呼び、ネイティブ API の this を保持します。
    if (options.tabId === undefined) return api.runtime.sendMessage(message)
    if (!api.tabs?.sendMessage)
      throw new UnsupportedOperationError('messaging.send to tab')
    const target = {
      ...(options.frameId === undefined ? {} : { frameId: options.frameId }),
      ...(options.documentId === undefined
        ? {}
        : { documentId: options.documentId }),
    }
    return api.tabs.sendMessage(options.tabId, message, target)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const response = (await Promise.race([
      send(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new MessageTimeoutError(timeoutMs)),
          timeoutMs
        )
        if (signal) {
          onAbort = () =>
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }
      }),
    ])) as
      | {
          __webext_rpc__?: number
          ok?: boolean
          empty?: boolean
          value?: Response
          error?: { name: string; message: string }
        }
      | undefined
    if (response?.__webext_rpc__ !== 1 || typeof response.ok !== 'boolean') {
      throw new Error(`No compatible response for ${name}:${type}`)
    }
    if (!response.ok)
      throw new RemoteError(
        response.error?.message ?? 'Remote handler failed',
        response.error?.name ?? 'Error'
      )
    return (response.empty ? undefined : response.value) as Response
  } finally {
    pending?.dispose()
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
