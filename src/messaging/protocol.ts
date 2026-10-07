import { encode, normalizeError } from './serialization'

/** runtimeとDOMの通信経路で共通の応答形式を使います。 */
export function successResponse(value: unknown) {
  return {
    __webext_rpc__: 1,
    ok: true,
    value: encode(value),
    empty: value === undefined,
  }
}

export function errorResponse(error: unknown) {
  return { __webext_rpc__: 1, ok: false, error: normalizeError(error) }
}
