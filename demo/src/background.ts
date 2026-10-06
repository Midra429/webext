import type { BackgroundMessages } from './messages'

import { createWebExt } from '../../src'

const webext = createWebExt({ context: 'background' })
webext.initialize()

const channel = webext.messaging.channel<BackgroundMessages>('demo/background')
channel.handle('echo', ({ text }, sender) => {
  if (typeof text !== 'string' || text.length > 256)
    throw new TypeError('文字列は256文字以内で指定してください')
  return {
    text,
    browser: webext.context.browser,
    context: webext.context.type,
    senderTabId: sender.tab?.id ?? null,
  }
})
channel.handle('fail', () => {
  throw new TypeError('デモ用の意図的なエラーです')
})
channel.handle('slow', async () => {
  // 永続的なサービスワーカーのタイマーではなく、短時間だけ保留する RPC 応答。
  await new Promise((resolve) => setTimeout(resolve, 750))
  return '遅延応答が完了しました'
})
channel.handle('actionMode', async (mode) => {
  if (mode !== 'side' && mode !== 'popup')
    throw new TypeError('不正なactionモードです')
  await webext.action.setPopup({ popup: mode === 'side' ? '' : 'popup.html' })
  return mode === 'side'
    ? '次のアイコンクリックでサイドパネルを開きます'
    : '次のアイコンクリックでポップアップを開きます'
})

webext.side.bindActionClick(console.error)

webext.runtime.onInstalled.addListener(() => {
  void (async () => {
    try {
      await webext.menus.removeAll()
      webext.menus.create({
        id: 'demo-record-tab',
        title: 'webext demo: タブ情報を記録',
        contexts: ['page'],
      })
    } catch (error) {
      console.error(error)
    }
  })()
})
webext.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'demo-record-tab') return
  void (async () => {
    try {
      await webext.storage.local.setValue('demo:menu', {
        time: new Date().toISOString(),
        tabId: tab?.id ?? null,
        title: tab?.title ?? null,
        url: tab?.url ?? null,
      })
      await webext.action.setBadgeText({ text: 'OK' })
      await webext.action.setBadgeBackgroundColor({ color: '#275ac7' })
    } catch (error) {
      console.error(error)
    }
  })()
})
