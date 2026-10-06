import type { StorageArea } from '../../src'
import type { BackgroundMessages, ContentMessages } from './messages'

import { RemoteError, webext } from '../../src'
import { createOperations } from './operations'

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element: ${id}`)
  return node as T
}
const status = element('status')
const results = element('results')
const areaSelect = element<HTMLSelectElement>('area')
const storedValue = element<HTMLInputElement>('stored-value')
const messageInput = element<HTMLInputElement>('message')
const storageForm = element<HTMLFormElement>('storage-form')
const messageForm = element<HTMLFormElement>('message-form')
const messageSubmit = messageForm.querySelector<HTMLButtonElement>(
  'button[type="submit"]'
)
if (!messageSubmit) throw new Error('Missing message submit button')
const buttons = new Map(
  Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[id]'),
    (button) => [button.id, button] as const
  )
)
function buttonElement(id: string): HTMLButtonElement {
  const button = buttons.get(id)
  if (!button) throw new Error(`Missing button: ${id}`)
  return button
}
const saveButton = buttonElement('save')
const watchButton = buttonElement('watch')
const background =
  webext.messaging.channel<BackgroundMessages>('demo/background')
const content = webext.messaging.channel<ContentMessages>('demo/content')
let stopWatch: (() => void) | undefined
let windowId: number | undefined
let prepared = false

function log(label: string, value: unknown, kind = 'success') {
  const entry = document.createElement('li')
  entry.dataset.kind = kind
  const heading = document.createElement('div')
  heading.className = 'log-heading'
  heading.textContent = `${new Date().toLocaleTimeString()}  ${label}`
  const output = document.createElement('pre')
  output.textContent = (
    value === undefined ? 'undefined' : JSON.stringify(value, null, 2)
  ).slice(0, 12_000)
  entry.append(heading, output)
  results.prepend(entry)
  while (results.children.length > 20) results.lastElementChild?.remove()
  status.textContent = `${label}: ${kind === 'error' ? 'エラー（詳細はログを確認）' : '完了'}`
}
function storage(): StorageArea {
  const name = areaSelect.value
  if (
    name !== 'local' &&
    name !== 'sync' &&
    name !== 'session' &&
    name !== 'managed'
  )
    throw new Error('不正なストレージ領域です')
  const area = webext.storage[name]
  if (!area) throw new Error(`${name} はこの環境で利用できません`)
  return area
}
function updateControls() {
  const cap = webext.side.capabilities
  const controls: Record<string, boolean> = {
    'side-open': prepared && cap.open,
    'side-close': prepared && cap.close,
    'side-state': cap.path,
    'side-alternate': cap.path,
    'side-reset': cap.path,
    'side-popout': cap.path,
    'unlinked-popout': cap.path,
    'action-side': cap.actionClick,
    save: areaSelect.value !== 'managed',
    remove: areaSelect.value !== 'managed',
  }
  for (const [id, enabled] of Object.entries(controls)) {
    const button = buttonElement(id)
    button.disabled = !enabled || operations.isBusy(button)
    button.title = enabled ? '' : 'この環境・領域では利用できません'
  }
}
const operations = createOperations({
  onStart(label) {
    status.textContent = `${label}: 実行中...`
  },
  onSuccess: log,
  onError(label, error) {
    log(
      label,
      {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof RemoteError
          ? { remoteName: error.remoteName }
          : {}),
      },
      'error'
    )
  },
  onSettled: updateControls,
})
const { execute } = operations
function bind(
  id: string,
  label: string,
  task: () => unknown | Promise<unknown>
) {
  const button = buttonElement(id)
  button.addEventListener('click', () => {
    void execute(label, task, button)
  })
}
function sideTarget() {
  return webext.side.capabilities.targetedOpen && windowId !== undefined
    ? { windowId }
    : undefined
}

bind('context', '実行環境', () => ({
  ...webext.context,
  side: webext.side.capabilities,
  storage: storage().capabilities,
}))
bind('active-tab', 'getCurrentActive', () => webext.tabs.getCurrentActive())
bind('target-tab', 'getTarget', () => webext.tabs.getTarget())
bind('self-tab', 'getSelf', () => webext.tabs.getSelf())
bind('side-open', 'side.open', () => webext.side.open(sideTarget()))
bind('side-close', 'side.close', () => webext.side.close(sideTarget()))
bind('side-state', 'サイドの状態', async () => ({
  path: await webext.side.getPath(),
  isOpen: webext.side.capabilities.isOpen
    ? await webext.side.isOpen(sideTarget())
    : 'unsupported',
  measurement: webext.side.capabilities.isOpen,
}))
bind('side-alternate', 'side.setPath（別パス）', () =>
  webext.side.setPath('sidepanel.html?variant=alternate')
)
bind('side-reset', 'side.setPath（初期パス）', () =>
  webext.side.setPath('sidepanel.html')
)
bind('side-popout', 'side.openPopout', () =>
  webext.side.openPopout({ width: 520, height: 820 })
)
bind('action-popout', 'action.openPopout', () =>
  webext.action.openPopout({ width: 520, height: 820 })
)
bind('unlinked-popout', 'リンクなしポップアウト', () =>
  webext.side.openPopout({ tabId: null, width: 520, height: 820 })
)
bind('action-side', 'actionの動作変更', () =>
  background.send('actionMode', 'side')
)
bind('action-popup', 'actionの動作変更', () =>
  background.send('actionMode', 'popup')
)

storageForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void execute(
    'setValue',
    () => storage().setValue('demo:value', storedValue.value),
    saveButton
  )
})
bind('read', '保存データ', async () => {
  const area = storage()
  const [value, keys, bytes] = await Promise.all([
    area.getValue('demo:value'),
    area.getKeys(),
    area.getBytesInUse(),
  ])
  return { value: value ?? null, keys, bytes, capabilities: area.capabilities }
})
bind('remove', 'remove', () => storage().remove('demo:value'))
bind('watch', '変更監視', () => {
  if (stopWatch) {
    stopWatch()
    stopWatch = undefined
    watchButton.textContent = '変更を監視'
    return '監視を停止しました'
  }
  const name = areaSelect.value
  stopWatch = storage().watch<string>('demo:value', (value, previous) => {
    log(
      `watch (${name})`,
      { previous: previous ?? null, value: value ?? null },
      'notice'
    )
  })
  watchButton.textContent = '監視を停止'
  return `${name} の監視を開始しました`
})
areaSelect.addEventListener('change', () => {
  stopWatch?.()
  stopWatch = undefined
  watchButton.textContent = '変更を監視'
  updateControls()
})

messageForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void execute(
    'エコー応答',
    () =>
      background.send('echo', {
        text: messageInput.value,
      }),
    messageSubmit
  )
})
bind('remote-error', 'RemoteError（意図的な失敗）', () =>
  background.send('fail', null)
)
bind('timeout', 'MessageTimeoutError（意図的な失敗）', () =>
  background.send('slow', null, { timeoutMs: 200 })
)
bind('abort', 'AbortSignal（意図的な中断）', async () => {
  const controller = new AbortController()
  const waiting = background.send('slow', null, { signal: controller.signal })
  controller.abort(new DOMException('デモから待機を中断しました', 'AbortError'))
  return await waiting
})
bind('inspect-content', 'コンテンツスクリプト', async () => {
  const tabId = await webext.tabs.getTargetId()
  if (tabId === undefined) throw new Error('対象タブがありません')
  try {
    return await content.send('inspect', null, { tabId, frameId: 0 })
  } catch (error) {
    throw new Error(
      'example.com / example.org を開き、サイトアクセスを許可してページを再読み込みしてください。',
      { cause: error }
    )
  }
})
bind('menu-result', '右クリックメニューの記録', () =>
  webext.storage.local.getValue('demo:menu', null)
)
buttonElement('clear').addEventListener('click', () => {
  results.replaceChildren()
  status.textContent = 'ログを消去しました'
})

for (const input of document.querySelectorAll('input')) {
  const update = () => {
    if (input.matches(':user-invalid'))
      input.setAttribute('aria-invalid', 'true')
    else input.removeAttribute('aria-invalid')
  }
  input.addEventListener('blur', update)
  input.addEventListener('input', update)
  input.addEventListener('invalid', () =>
    input.setAttribute('aria-invalid', 'true')
  )
}

async function initialize() {
  document.body.dataset.view =
    webext.context.type === 'popup' && !webext.context.isPopout
      ? 'popup'
      : 'panel'
  const variant = new URLSearchParams(location.search).get('variant')
  element('environment').textContent =
    `${webext.context.browser} / ${webext.context.type ?? 'unknown'}${webext.context.isPopout ? ' / popout' : ''}${variant ? ` / ${variant}` : ''}`
  const sessionOption = areaSelect.querySelector<HTMLOptionElement>(
    'option[value="session"]'
  )
  if (sessionOption) sessionOption.disabled = !webext.storage.session
  try {
    const [tab, currentWindow] = await Promise.all([
      webext.tabs.getTarget(),
      webext.windows.getCurrent(),
    ])
    windowId = tab?.windowId ?? currentWindow.id
    prepared = true
    status.textContent = '準備できました。各操作の結果をこの下に表示します。'
  } catch (error) {
    log(
      '初期化',
      { message: error instanceof Error ? error.message : String(error) },
      'error'
    )
  }
  updateControls()
}
void initialize()
window.addEventListener(
  'pagehide',
  () => {
    stopWatch?.()
    webext.dispose()
  },
  { once: true }
)
