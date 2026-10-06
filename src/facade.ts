/** グローバルAPIを変更せず、ネイティブメソッドの呼び出し元を維持する。 */
export function facade<T extends object, Extra extends object>(
  native: T,
  extra: Extra
): T & Extra {
  const target = Object.assign(Object.create(null), extra) as T & Extra
  const bound = new Map<PropertyKey, { original: Function; value: Function }>()
  return new Proxy(target, {
    get(target, key, receiver) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver)
      const value = Reflect.get(native, key, native)
      if (typeof value !== 'function') return value
      let entry = bound.get(key)
      if (!entry || entry.original !== value) {
        entry = { original: value, value: value.bind(native) }
        bound.set(key, entry)
      }
      return entry.value
    },
    has(target, key) {
      return Reflect.has(target, key) || Reflect.has(native, key)
    },
    ownKeys(target) {
      return [
        ...new Set([...Reflect.ownKeys(native), ...Reflect.ownKeys(target)]),
      ]
    },
    getOwnPropertyDescriptor(target, key) {
      return (
        Reflect.getOwnPropertyDescriptor(target, key) ??
        (Reflect.has(native, key)
          ? {
              configurable: true,
              enumerable: true,
              get: () => Reflect.get(native, key, native),
            }
          : undefined)
      )
    },
  })
}

/** 初回のアクセスまで初期化を遅延し、初期化後と同じプロパティ参照を提供する。 */
export function lazyFacade<T extends object>(initialize: () => T): T {
  let instance: T | undefined
  const getInstance = () => (instance ??= initialize())
  return new Proxy({} as T, {
    get(_target, key) {
      return Reflect.get(getInstance(), key)
    },
    set(_target, key, value) {
      return Reflect.set(getInstance(), key, value)
    },
    has(_target, key) {
      return Reflect.has(getInstance(), key)
    },
    ownKeys() {
      return Reflect.ownKeys(getInstance())
    },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(getInstance(), key)
      return descriptor && { ...descriptor, configurable: true }
    },
  })
}
