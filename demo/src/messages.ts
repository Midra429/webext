export interface BackgroundMessages {
  echo: {
    request: { text: string }
    response: {
      text: string
      browser: string
      context: string | null
      senderTabId: number | null
    }
  }
  fail: { request: null; response: null }
  slow: { request: null; response: string }
  actionMode: { request: 'side' | 'popup'; response: string }
}

export interface ContentMessages {
  inspect: {
    request: null
    response: {
      title: string
      url: string
      selfId: number | null
      targetId: number | null
      activeId: number | null
      nativeTabsAvailable: boolean
    }
  }
}
