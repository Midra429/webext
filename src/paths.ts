export const LINKED_TAB_ID_NAME = '_webext_linked_tab_id'
export const POPOUT_NAME = '_webext_popout'

const ambiguousRelativePath = /^(?:\/|[^/]*:)/

export function isExtensionUrl(url: URL, extensionUrl: URL): boolean {
  return (
    url.protocol === extensionUrl.protocol && url.host === extensionUrl.host
  )
}

/** 外部URLを拒否し、拡張ルートを基準にページのURLを解決する。 */
export function resolveExtensionPath(path: string, extensionUrl: URL): URL {
  if (typeof path !== 'string' || !path.trim())
    throw new TypeError('A non-empty extension page path is required')
  const target = new URL(path, extensionUrl)
  if (!isExtensionUrl(target, extensionUrl))
    throw new TypeError('Path must point to a page in this extension')
  return target
}

export function normalizeExtensionPath(
  path: string,
  extensionUrl: URL
): string {
  const target = resolveExtensionPath(path, extensionUrl)
  const relativePath = target.pathname.slice(1)
  // 再解析時にスキームや別ホストとして扱われるパスは、相対指定を明示する。
  const normalized = ambiguousRelativePath.test(relativePath)
    ? `.${target.pathname}`
    : relativePath
  return `${normalized}${target.search}${target.hash}`
}
