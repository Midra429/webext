/** 一つの解除処理が失敗しても残りを実行し、例外は最後にまとめて伝播する。 */
export function disposeAll(cleanups: Iterable<() => void>): void {
  const errors: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      'webext: multiple cleanup operations failed'
    )
}

/** 登録した解除処理を一度だけ実行し、不要になった参照を取り除く。 */
export function createDisposables() {
  const disposers = new Set<() => void>()
  return {
    add(cleanup: () => void): () => void {
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        disposers.delete(dispose)
        cleanup()
      }
      disposers.add(dispose)
      return dispose
    },
    dispose() {
      // 解除中に追加された処理は、次回の解除対象として残す。
      disposeAll([...disposers])
    },
  }
}
