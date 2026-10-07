import type { NamespacedStorageArea, StorageArea } from './index'

const encoder = new TextEncoder()

/** @internal */
export function estimateBytes(values: Record<string, unknown>): number {
  let bytes = 0
  for (const key of Object.keys(values)) {
    bytes += encoder.encode(key).byteLength
    bytes += encoder.encode(JSON.stringify(values[key])).byteLength
  }
  return bytes
}

/** @internal */
export function assertStorageNamespace(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.includes(':'))
    throw new TypeError(
      'Storage namespace must be non-empty and contain no colon'
    )
}

/** @internal */
export function createNamespace(
  area: StorageArea,
  name: string
): NamespacedStorageArea {
  assertStorageNamespace(name)
  const prefix = `${name}:`
  const qualify = (key: string) => {
    if (typeof key !== 'string')
      throw new TypeError('Storage key must be a string')
    return `${prefix}${key}`
  }
  const qualifyKeys = (keys: string | string[]) =>
    Array.isArray(keys) ? keys.map(qualify) : qualify(keys)
  const encode = (items: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(items).map(([key, value]) => [qualify(key), value])
    )
  const scopedEntries = (items: Record<string, unknown>) =>
    Object.entries(items).filter(([key]) => key.startsWith(prefix))
  const decode = (items: Record<string, unknown>) =>
    Object.fromEntries(
      scopedEntries(items).map(([key, value]) => [
        key.slice(prefix.length),
        value,
      ])
    )
  const storedKeys = async () =>
    (await area.getKeys()).filter((key) => key.startsWith(prefix))

  return {
    capabilities: area.capabilities,
    async get(keys = null) {
      const qualified =
        keys == null
          ? null
          : typeof keys === 'string' || Array.isArray(keys)
            ? qualifyKeys(keys)
            : encode(keys)
      return decode(await area.get(qualified))
    },
    async set(items) {
      await area.set(encode(items))
    },
    async remove(keys) {
      await area.remove(qualifyKeys(keys))
    },
    async clear() {
      const keys = await storedKeys()
      // 読み取り専用領域では空の名前空間でもネイティブの拒否を伝播させる。
      await area.remove(keys)
    },
    async getKeys() {
      return (await storedKeys()).map((key) => key.slice(prefix.length))
    },
    async getBytesInUse(keys = null) {
      // キー列挙も推定も全件読み取りが必要な場合は、同じスナップショットを再利用する。
      if (
        keys == null &&
        area.capabilities.getKeys === 'polyfilled' &&
        area.capabilities.getBytesInUse === 'estimated'
      )
        return estimateBytes(
          Object.fromEntries(scopedEntries(await area.get(null)))
        )
      return area.getBytesInUse(
        keys == null ? await storedKeys() : qualifyKeys(keys)
      )
    },
    async getValue<T>(key: string, defaultValue?: T): Promise<T> {
      return area.getValue(qualify(key), defaultValue as T)
    },
    async setValue(key, value) {
      await area.setValue(qualify(key), value)
    },
    watch(key, listener) {
      return area.watch(qualify(key), listener)
    },
  }
}
