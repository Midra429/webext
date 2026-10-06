import type { MessagingApi, SendOptions } from './types'

import {
  MessageTimeoutError,
  RemoteError,
  UnsupportedOperationError,
  assertTabId,
} from '../errors'
import { encode } from './serialization'

const MAX_TIMEOUT_MS = 2_147_483_647

export async function sendMessage<Response>(
  api: MessagingApi,
  name: string,
  type: string,
  request: unknown,
  options: SendOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be positive, finite and at most ${MAX_TIMEOUT_MS}`
    )
  }
  if (options.signal?.aborted)
    throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (options.tabId !== undefined) assertTabId(options.tabId)
  if (
    options.tabId === undefined &&
    (options.frameId !== undefined || options.documentId !== undefined)
  ) {
    throw new TypeError('frameId/documentId requires tabId')
  }
  const message = {
    __webext_rpc__: 1,
    channel: name,
    type,
    payload: encode(request),
    empty: request === undefined,
  }
  const send = () => {
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
        if (options.signal) {
          onAbort = () =>
            reject(
              options.signal?.reason ??
                new DOMException('Aborted', 'AbortError')
            )
          options.signal.addEventListener('abort', onAbort, { once: true })
          if (options.signal.aborted) onAbort()
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
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
}
