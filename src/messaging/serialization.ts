/** JSON に限定し、Chrome と Firefox のペイロードの扱いを統一します。 */
export function encode(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number' && Number.isFinite(value))
    return value === 0 ? 0 : value
  const snapshots = new WeakMap<object, unknown>()
  const visit = (item: unknown, ancestors: Set<object>): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || item === null)
      throw new TypeError('Messages must contain JSON-compatible values')
    if (ancestors.has(item))
      throw new TypeError('Messages must not contain cycles')
    const cached = snapshots.get(item)
    if (cached !== undefined) return cached
    const isArray = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Messages must use plain objects and arrays')
    }
    ancestors.add(item)
    let snapshot: unknown
    if (isArray) {
      const array: unknown[] = []
      const length = item.length
      for (let index = 0; index < length; index++) {
        array.push(index in item ? visit(item[index], ancestors) : null)
      }
      snapshot = array
    } else {
      // プロトタイプなしのスナップショットで __proto__ などのキーもデータとして保持します。
      const object: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(item)) {
        const child = (item as Record<string, unknown>)[key]
        if (child !== undefined) object[key] = visit(child, ancestors)
      }
      snapshot = object
    }
    ancestors.delete(item)
    snapshots.set(item, snapshot)
    return snapshot
  }
  // 検証済みスナップショットだけを直列化し、入力のゲッターを再評価しません。
  // JSON の往復で負のゼロを正規化し、共有参照を独立した値に変換します。
  return JSON.parse(JSON.stringify(visit(value, new Set()))) as unknown
}

export function normalizeError(error: unknown): {
  name: string
  message: string
} {
  try {
    return error instanceof Error
      ? { name: String(error.name), message: String(error.message) }
      : { name: 'Error', message: String(error) }
  } catch {
    return { name: 'Error', message: 'Remote handler failed' }
  }
}
