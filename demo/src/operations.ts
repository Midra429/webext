type OperationButton = Pick<HTMLButtonElement, 'disabled'>

interface OperationCallbacks {
  onStart(label: string): void
  onSuccess(label: string, value: unknown): void
  onError(label: string, error: unknown): void
  onSettled(): void
}

export function createOperations(callbacks: OperationCallbacks) {
  const busy = new Set<OperationButton>()

  async function execute(
    label: string,
    task: () => unknown | Promise<unknown>,
    button?: OperationButton
  ) {
    if (button && (button.disabled || busy.has(button))) return
    if (button) {
      busy.add(button)
      button.disabled = true
    }
    try {
      callbacks.onStart(label)
      // ユーザー操作を維持するため、最初の await より前に元のクリック処理内で呼び出す。
      callbacks.onSuccess(label, await task())
    } catch (error) {
      callbacks.onError(label, error)
    } finally {
      if (button) {
        busy.delete(button)
        button.disabled = false
      }
      // 完了時点の対応状況・ストレージ領域を反映する。他の処理の実行中状態は維持する。
      callbacks.onSettled()
    }
  }

  return { execute, isBusy: (button: OperationButton) => busy.has(button) }
}
