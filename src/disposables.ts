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
      for (const dispose of [...disposers]) dispose()
    },
  }
}
