import type { DemoStoredValue } from './messages'

import { createMainWorldStorage } from '../../src'
import { createOperations } from './operations'

const storage = createMainWorldStorage({
  namespace: 'demo-main-storage',
  timeoutMs: 5_000,
})
const area = storage.local.namespace<DemoStoredValue>('demo-main')
const listeners = new AbortController()
let stopWatch: (() => void) | undefined

const panel = document.createElement('fieldset')
const heading = document.createElement('legend')
heading.textContent = 'webext demo: MAIN world storage'
const description = document.createElement('p')
description.textContent =
  '公開範囲は local / demo-main のみ（書込可）。秘密情報は入力しないでください。通信はクリック時に開始します。'
const label = document.createElement('label')
label.textContent = '保存する文字列 '
const input = document.createElement('input')
input.type = 'text'
input.value = 'Hello from MAIN'
input.maxLength = 256
label.append(input)
const actions = document.createElement('p')
const status = document.createElement('p')
status.setAttribute('role', 'status')
status.textContent =
  '監視は初期値を通知しません。「読む」で現在値を確認してください。'
const results = document.createElement('ol')
panel.append(heading, description, label, actions, status, results)
document.body.prepend(panel)

function log(label: string, value: unknown) {
  const entry = document.createElement('li')
  const title = document.createElement('strong')
  title.textContent = label
  const output = document.createElement('pre')
  output.style.whiteSpace = 'pre-wrap'
  output.textContent = (
    value === undefined ? 'undefined' : JSON.stringify(value, null, 2)
  ).slice(0, 12_000)
  entry.append(title, output)
  results.prepend(entry)
  while (results.children.length > 20) results.lastElementChild?.remove()
  status.textContent = label
}
const operations = createOperations({
  onStart(label) {
    status.textContent = `${label}: 実行中...`
  },
  onSuccess: log,
  onError(label, error) {
    log(`${label}: エラー`, {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    })
  },
  onSettled() {},
})
function button(label: string, task: () => unknown | Promise<unknown>) {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = label
  node.addEventListener(
    'click',
    () => {
      void operations.execute(label, task, node)
    },
    { signal: listeners.signal }
  )
  actions.append(node, document.createTextNode(' '))
  return node
}

// ブリッジの登録順に依存しないよう、初期化時には要求を送らない。
button('読む', async () => {
  const [value, keys, bytes, capabilities] = await Promise.all([
    area.getValue('value', '(未保存)'),
    area.getKeys(),
    area.getBytesInUse(),
    area.getCapabilities(),
  ])
  return { value, keys, bytes, capabilities }
})
button('保存', async () => {
  await area.setValue('value', input.value)
  return 'demo-main:value に保存しました'
})
button('削除', async () => {
  await area.remove('value')
  return 'demo-main:value を削除しました'
})
button('名前空間をクリア', async () => {
  await area.clear()
  return 'demo-main のみをクリアしました（キー列挙後の削除で非アトミック）'
})
const watchButton = button('変更を監視', () => {
  if (stopWatch) {
    stopWatch()
    stopWatch = undefined
    watchButton.textContent = '変更を監視'
    return '監視を停止しました'
  }
  stopWatch = area.watch('value', (value, previous) => {
    log('watch: 変更通知', {
      previous: previous ?? null,
      value: value ?? null,
    })
  })
  watchButton.textContent = '監視を停止'
  return 'ローカル購読を開始しました（権限確認・初期値の再送はありません）'
})
button('未公開scopeを読む（拒否）', () =>
  storage.local.namespace('demo').getValue('menu')
)

window.addEventListener(
  'pagehide',
  () => {
    listeners.abort()
    stopWatch?.()
    storage.dispose()
    panel.remove()
  },
  { once: true }
)
