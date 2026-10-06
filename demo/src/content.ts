import type { ContentMessages } from './messages'

import { createWebExt } from '../../src'

const webext = createWebExt({ context: 'content-script' })
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
