import type { ContentMessages } from './messages'

import { createWebExt } from '../../src'

const webext = createWebExt({ context: 'content-script' })
const stopStorageBridge = webext.storage.bridgeMainWorld({
  namespace: 'demo-main-storage',
  scopes: [{ area: 'local', namespace: 'demo-main', writable: true }],
  onError: console.error,
})
const channel = webext.messaging.channel<ContentMessages>('demo/content')
channel.handle('inspect', async () => {
  const [selfId, targetId, activeId] = await Promise.all([
    webext.tabs.getSelfId(),
    webext.tabs.getTargetId(),
    webext.tabs.getCurrentActiveId(),
  ])
  return {
    title: document.title,
    url: location.href,
    selfId: selfId ?? null,
    targetId: targetId ?? null,
    activeId: activeId ?? null,
    nativeTabsAvailable: webext.tabs.available,
  }
})
window.addEventListener(
  'pagehide',
  () => {
    stopStorageBridge()
    webext.dispose()
  },
  { once: true }
)
