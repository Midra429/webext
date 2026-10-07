import { copyFile, mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

const root = import.meta.dir
const source = join(root, 'src')
const result = await Bun.build({
  entrypoints: ['background.ts', 'page.ts', 'content.ts', 'main.ts'].map(
    (file) => join(source, file)
  ),
  target: 'browser',
  format: 'iife',
  naming: '[name].js',
})
if (!result.success) throw new AggregateError(result.logs, 'Demo build failed')

const common = {
  manifest_version: 3,
  name: 'webext demo',
  version: '0.1.0',
  description:
    '@midra/webextのタブ・サイドパネル・ストレージ・メッセージングを試す開発用デモ',
  permissions: ['storage', 'tabs', 'contextMenus'],
  action: { default_title: 'webext demo', default_popup: 'popup.html' },
  content_scripts: [
    {
      matches: ['https://example.com/*', 'https://example.org/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://example.com/*', 'https://example.org/*'],
      js: ['main.js'],
      world: 'MAIN',
      run_at: 'document_idle',
    },
  ],
}
const manifests = {
  chrome: {
    ...common,
    permissions: [...common.permissions, 'sidePanel'],
    background: { service_worker: 'background.js' },
    side_panel: { default_path: 'sidepanel.html' },
  },
  firefox: {
    ...common,
    background: { scripts: ['background.js'] },
    sidebar_action: {
      default_title: 'webext demo',
      default_panel: 'sidepanel.html',
    },
    browser_specific_settings: {
      gecko: {
        id: 'webext-demo@midra.local',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
}
for (const [browser, manifest] of Object.entries(manifests)) {
  const outdir = join(root, 'dist', browser)
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  for (const artifact of result.outputs)
    await Bun.write(join(outdir, basename(artifact.path)), artifact)
  for (const page of ['popup.html', 'sidepanel.html'])
    await copyFile(join(source, 'view.html'), join(outdir, page))
  await copyFile(join(source, 'style.css'), join(outdir, 'style.css'))
  await Bun.write(
    join(outdir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  // ブラウザー自動化や追加のテスト依存なしで、生成したマニフェスト・ページの参照先を確認する。
  for (const file of [
    'background.js',
    'content.js',
    'main.js',
    'page.js',
    'popup.html',
    'sidepanel.html',
    'style.css',
  ]) {
    if (!(await Bun.file(join(outdir, file)).exists()))
      throw new Error(`Missing demo asset: ${browser}/${file}`)
  }
  console.log(`Built demo/dist/${browser}`)
}
