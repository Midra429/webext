# @midra/webext

Chrome / Firefox の WebExtensions API を共通のインターフェースで扱うためのライブラリです。足りないメソッドの補完、API 名の統一、タブ取得やポップアウトなどの実用ヘルパーを提供します。特定ブラウザの API の完全な模倣は目指しません。

> **AI 生成について**：本ライブラリのコードおよび本 README は、AI によって生成されています。利用時は、対象ブラウザでの動作・権限・セキュリティ要件を確認してください。

## 主な機能

- **サイドパネル**：`webext.side` で Chrome / Firefox の操作を共通化。
- **タブ取得・ポップアウト**：コンテンツスクリプト自身のタブ取得と、タブに関連付けた別ウィンドウの作成。
- **ストレージ**：不足メソッドの補完、値の取得・保存、変更監視。
- **型付きメッセージング**：チャンネルごとのリクエスト・レスポンスの型定義。MAIN worldとの双方向通信にも対応。
- **メニュー**：`menus` で Firefox の `menus` / Chrome の `contextMenus` の差異を吸収。

グローバルの `chrome` / `browser` は変更しません。WXT、ビルド時のブラウザ指定、追加のランタイム依存は不要です。

## 目次

- [対応方針](#対応方針)
- [基本と初期化](#基本と初期化)
- [サイドパネル](#サイドパネル)
- [タブ](#タブ)
- [ポップアウト](#ポップアウト)
- [ストレージ](#ストレージ)
- [型付きメッセージング](#型付きメッセージング)
- [ネイティブ API と移行](#ネイティブ-api-と移行)
- [デモ拡張](#デモ拡張)
- [開発](#開発)

## 対応方針

Manifest V3 と Promise 版のネイティブ API がある、最新版の Chrome / Firefox を対象とします。

- 個別の API には、バージョン・権限・マニフェスト設定の要件があります。
- Chrome のサイドパネルの `close` は、Chrome 141 以降で利用できます。
- 共通 API は Promise 形式です。ネイティブ API 全体を旧バージョン向けに Promise 化するものではありません。
- コールバック形式のみの古い API や、OS・ブラウザに機能自体がない API まで補完できるとは限りません。

## 基本と初期化

### 1. バックグラウンドで初期化

**バックグラウンドのトップレベルで `webext.initialize()` を同期的に呼んでください。** コンテンツスクリプト用のタブ取得ブリッジを登録します。サービスワーカーの再起動時も、トップレベルで再登録されます。

```ts
import { webext } from '@midra/webext'

webext.initialize()
```

### 2. 共通 API を利用

```ts
import { webext } from '@midra/webext'

const tab = await webext.tabs.getTarget()
const keys = await webext.storage.local.getKeys()
```

`webext` は最初のアクセス時に初期化します。モジュールのインポートだけなら拡張機能以外でも可能ですが、API へのアクセスには拡張機能の環境が必要です。

### 実行コンテキストを明示する場合

```ts
import { createWebExt } from '@midra/webext'

const webext = createWebExt({ context: 'sidepanel' })
```

`api`、`url`、`browser` も明示指定できます。テストでは `api` を注入できます。

| プロパティ | 値・用途 |
| --- | --- |
| `context.type` | `background` / `content-script` / `popup` / `sidepanel` / `null`。画面の役割はマニフェストから推測しますが、動的に変更したパスや独自画面では明示指定してください |
| `context.browser` | `chrome`（Chromium 系）/ `firefox` / `unknown`。通常の処理では、この値による分岐は不要です |

## サイドパネル

`webext.side` で、Chrome の `sidePanel` / Firefox の `sidebarAction` を共通の操作として利用できます。

| API | 動作 |
| --- | --- |
| `available` | 開くためのAPIがあるか。表示状態ではありません |
| `capabilities` | `open` / `close` / `path` / `isOpen` / `targetedOpen` / `actionClick` の対応状況 |
| `open()` | 現在のウィンドウで開く |
| `close()` | 閉じる。パネルを無効化したりパスを変更したりしません |
| `getPath({ tabId? }?)` | 設定中の拡張ルート相対パスを返す。クエリ・ハッシュを保持 |
| `setPath(path, { tabId? }?)` | パスを変更。対象省略時はグローバル設定 |
| `isOpen({ windowId? }?)` | 指定ウィンドウ（省略時は現在）で表示されているか |
| `openPopout(options?)` | 対象タブに設定中のパネルを別ウィンドウで開く |
| `bindActionClick(onError)` | actionクリック時に開く。解除関数を返す |

```ts
// backgroundのトップレベル。actionに default_popup があるとクリックイベントは発火しません。
const unbind = webext.side.bindActionClick(console.error)

// 拡張ページのボタンから開く場合
button.addEventListener('click', () => {
  void webext.side.open().catch(console.error)
})

// パス設定はユーザー操作より前の初期設定時などに実行
await webext.side.setPath('ui/side.html')
await webext.side.openPopout({ width: 420, height: 720 })
```

### マニフェスト設定

Chrome の設定（関連部分のみ）：

```json
{
  "manifest_version": 3,
  "action": {},
  "permissions": ["sidePanel"],
  "side_panel": { "default_path": "ui/side.html" }
}
```

Firefox の設定（関連部分のみ）：

```json
{
  "manifest_version": 3,
  "action": {},
  "sidebar_action": { "default_panel": "ui/side.html" }
}
```

パネル用 HTML は利用側で用意してください。マニフェストのビルド時変換は行いません。

### サイドパネルの制約

- `open()` はユーザー操作から直接呼びます。内部でネイティブ呼び出し前の非同期検索・設定更新は行いません。
- Chromeの対象省略は現在のウィンドウのグローバルパネル。タブ固有のパネルには `{ tabId }` を指定します。`open()` は同期的に `WINDOW_ID_CURRENT` を渡します。この定数に未対応の古いChromeでは、クリックイベントの `tab.windowId` など実際のIDを指定してください。
- Firefoxは明示的な開閉対象指定に対応しません（`windowId: -2` は現在のウィンドウとして扱います）。未対応操作は `UnsupportedOperationError` になります。
- `getPath()` は両ブラウザでルート相対パスに統一。`setPath()` は同じ拡張内の絶対URLも受け付けます。外部URLは拒否します。
- `isOpen()` はFirefoxの `sidebarAction.isOpen()` / Chromeの `runtime.getContexts()` を利用します。`capabilities.isOpen` は `native` / `document` / `false`。Chromeではパネルドキュメントの存在を観測するため、切り替え・終了途中などの厳密なUI表示状態とは一致しない可能性があります。未対応環境ではエラーにします。
- `available` / `capabilities` はAPIの存在確認です。権限やmanifest設定が正しいことまでは保証しません。
- `bindActionClick()` はbackground起動時に登録してください。解除は戻り値、または `webext.dispose()` で行えます。
- 配置、無効化、ブラウザ固有の開閉イベントなどはネイティブAPIを利用してください。ダミーイベントは提供しません。

## タブ

```ts
await webext.tabs.getCurrentActive()   // 現在のウィンドウのアクティブタブ
await webext.tabs.getCurrentActiveId()
await webext.tabs.getSelf()            // コンテンツスクリプト自身を含むタブ
await webext.tabs.getSelfId()
await webext.tabs.getTarget()          // リンク先 → コンテンツスクリプト自身 → アクティブタブ
await webext.tabs.getTargetId()
```

コンテンツスクリプトでも共通ヘルパーを使用できます。background側の `initialize()` が必要です。`getCurrentActive()` は送信元タブのウィンドウに限定して検索します。

`tabs.available` はネイティブのtabs APIが利用可能かどうかです。コンテンツスクリプトで `false` でも上記ヘルパーはブリッジ経由で動きます。`query()` などネイティブメソッドは直接使用できません。

タブがなければ `undefined`。リンク先が閉じられていた場合はエラーを伝播し、別のタブへ自動的に切り替えません。URLなどの情報には `tabs` やホスト権限が必要です。

## ポップアウト

```ts
await webext.action.openPopout({ width: 420, tabId: 123 })
await webext.side.openPopout({ width: 420 })
await webext.side.openPopout({ tabId: null }) // リンクなし
```

`tabId` は関連付けるタブのIDで、既存タブを移動する指定ではありません。省略時は `getTarget()` の対象を使います。現在のaction/panel設定を取得し、URLのクエリ・ハッシュを保持します。actionのpopupが空に設定されている場合はエラーで、manifestの初期値へ勝手に戻しません。

`context.linkedTabId` はIDまたは `null`。`context.isPopout` はリンクなしでも `true` です。内部クエリパラメータは拡張ページでのみ解釈します。これらは便宜上の情報であり、認証・アクセス制御には利用できません。

## ストレージ

存在する `local` / `sync` / `managed` / `session` 領域に同じヘルパーを提供します。権限が必要です。未対応のsession領域はメモリや永続領域で代用しません。managed領域の書き込みはネイティブ側で拒否されます。

```ts
const theme = await webext.storage.local.getValue('theme', 'system')
await webext.storage.local.setValue('theme', 'dark')
const stop = webext.storage.local.watch<string>('theme', (value, previous) => {
  console.log(previous, value)
})
stop()
```

- `getKeys()`：ネイティブ優先。補完時は `get(null)` で全値を読んでキーを取得。
- `getBytesInUse(keys?)`：ネイティブ優先。補完時はキーとJSON化した値のUTF-8バイト数の合計。**推定値で、ディスク使用量やクォータ判定には使えません。**
- `capabilities.getKeys`：`native` / `polyfilled`。
- `capabilities.getBytesInUse`：`native` / `estimated`。
- `watch()`：値の変更・削除を監視。削除時は `undefined`。解除関数を返し、`webext.dispose()` でも解除。
- `getValue<T>()` の型指定は実行時検証ではありません。保存データの検証が必要なら利用側で行ってください。

## 型付きメッセージング

同じチャンネル名・スキーマを送受信側で共有します。1つのリクエストは1つのコンテキストで処理してください。

```ts
interface Messages {
  greet: { request: { name: string }; response: string }
}

const channel = webext.messaging.channel<Messages>('app/background')

// background（トップレベルで登録）
const stop = channel.handle('greet', ({ name }, sender) => `Hello, ${name}`)

// popup / content scriptなど別のコンテキスト
const result = await channel.send('greet', { name: 'Midra' })
```

`send()` の第3引数で `tabId`、`frameId`、`documentId`、`timeoutMs`、`signal` を指定できます。タブへの送信にはネイティブtabs APIが必要です。

- 応答待ちはデフォルト10秒。`timeoutMs` は正の有限数で、上限は `2_147_483_647` ミリ秒です。範囲外の指定は送信前に `TypeError`。タイムアウトは `MessageTimeoutError`。
- handlerの例外は `RemoteError` として伝播（元の名前は `remoteName`）。例外値を文字列化できない場合は、`remoteName: 'Error'`、メッセージ `'Remote handler failed'` にフォールバックします。
- `AbortSignal` とタイムアウトは送信側の待機のみ終了し、受信側の処理をキャンセルしません。
- Chrome / Firefoxで同じcallback応答方式を使用。handlerは同期的に呼び出し、非同期結果も応答できます。
- JSON互換値のみ送れます。Date、Map、BigInt、循環参照などは拒否。オブジェクト内の `undefined` プロパティは省略されます。
- 同じ拡張IDからの内部メッセージだけを受け付けます。未登録のメッセージを横取りしません。
- 型は実行時検証ではありません。受信値やsenderの追加検証は必要に応じてhandler内で行ってください。
- `stop()` / `channel.dispose()` / `webext.dispose()` でリスナーを解除。

### MAIN worldとの通信

MAIN worldでは拡張APIを使えないため、`createMainWorldMessaging()` を使用します。同じフレームのISOLATED worldコンテンツスクリプトで、中継を登録してください。既存の `channel().send()/handle()` とスキーマを共有できます。

```ts
// 共通の型
interface WorldMessages {
  greet: { request: string; response: string }
}
```

```ts
// ISOLATED worldのコンテンツスクリプト
import { webext } from '@midra/webext'

const stopBridge = webext.messaging.bridgeMainWorld({
  namespace: 'my-extension/world',
  channels: ['app/world'], // 中継を許可するチャンネルだけ指定
})
const channel = webext.messaging.channel<WorldMessages>('app/world')
channel.handle('greet', (name) => `Content: ${name}`)

const reply = await channel.send('greet', 'Midra', { target: 'main-world' })
```

```ts
// MAIN worldのスクリプト
import { createMainWorldMessaging } from '@midra/webext'

const messaging = createMainWorldMessaging({ namespace: 'my-extension/world' })
const channel = messaging.channel<WorldMessages>('app/world')
channel.handle('greet', (name) => `MAIN: ${name}`)

const backgroundReply = await channel.send('greet', 'Midra')
const contentReply = await channel.send('greet', 'Midra', {
  target: 'content-script',
})
```

```ts
// background（トップレベルで登録）
import { webext } from '@midra/webext'

const channel = webext.messaging.channel<WorldMessages>('app/world')
channel.handle('greet', (name, sender) => {
  console.log(sender.world, sender.tab?.id) // MAIN由来ならworldは 'MAIN'
  return `Background: ${name}`
})

// 任意のタイミングで、対象タブ・フレームのMAIN worldへ送る
const reply = await channel.send('greet', 'Midra', {
  target: 'main-world', tabId: 123, frameId: 0,
})
```

| 送信元 → 送信先 | `send()` の指定 |
| --- | --- |
| MAIN → background | 指定なし（または `target: 'background'`） |
| MAIN → 同じフレームのcontent script | `target: 'content-script'` |
| content script → 同じフレームのMAIN | `target: 'main-world'` |
| background / 拡張ページ → MAIN | `target: 'main-world', tabId`。必要なら `frameId` / `documentId` |

- 中継はコンテンツスクリプトのインスタンスにつき1つ。送信前に両worldのスクリプト・受信ハンドラー・中継を登録してください。MAIN worldのスクリプトの注入は利用側で行います。
- 中継に指定していないチャンネルは公開しません。通常のruntime/tabs通信は従来どおり動作します。`target: 'background'` は `runtime.sendMessage()` を使うため、該当する拡張内ハンドラーは1つにしてください。
- MAIN由来の要求には `sender.world: 'MAIN'` を付けます。backgroundにはネイティブの実際のタブ・フレーム情報を渡します。content script内のハンドラーにはページURLを渡し、拡張ID・タブIDは付けません。
- 通信は同じWindow・origin・namespaceに限定しますが、**ページのスクリプトも内容を読み書きできます**。namespace・`sender.world` は認証に使えません。公開する処理と要求値を検証し、機密情報をこの通信に載せないでください。
- JSON制約・`RemoteError`・タイムアウト・`AbortSignal` は既存の通信と同じです。タイムアウト／中止時にはDOM応答の待機も解除します。
- `stopBridge()` / `webext.dispose()` は中継を解除します。`messaging.dispose()` はMAIN側を解除します。これらの破棄は未完了のDOM応答待機を拒否します。受信済みの処理は継続します。
- 通常のHTTP(S)ページが対象です。`data:` やsandbox iframeなど、originが `null` のドキュメントは非対応です。

## ネイティブ API と移行

ブラウザ固有の操作には `webext.native` を使用できます。`webext.sidePanel` / `webext.sidebarAction` もネイティブのままです。

旧実装から移行する場合は、次のように置き換えてください。

| 旧実装 | 移行先 |
| --- | --- |
| サイドパネル操作 | `webext.side` |
| `sidePanel.path` | `side.getPath()` / `side.setPath()` |
| `action.path` | `action.getPopup()` で実際の設定を取得 |
| リンク先優先の `tabs.getCurrentActive()` | `tabs.getTarget()` |

## デモ拡張

Chrome / Firefox 向けの試験用拡張を生成できます。

```sh
bun run demo:build
```

読み込み方と操作手順は [demo/README.md](demo/README.md) を参照してください。

## 開発

依存関係をインストールしてから、必要なコマンドを実行してください。

```sh
bun install
bun run validate
bun run build
```

| コマンド | 内容 |
| --- | --- |
| `bun run validate` | 書式・静的解析・型チェック・全テスト（ファイルは変更しない） |
| `bun run check` | 書式・静的解析の検証のみ |
| `bun run check:fix` | 書式・静的解析の自動修正（ファイルを書き換える） |
| `bun run compile` | 型チェック |
| `bun test` | 全テスト |
| `bun run build` | ライブラリのビルド |
| `bun run demo:build` | デモ拡張のビルド |

リリース用ワークフローでも、ビルド前に `validate` を実行します。

### ソース構成

- `src/core.ts`：公開APIの組み立てと初期化。
- `src/context.ts` / `src/paths.ts`：実行環境判定、拡張内URLの検証。
- `src/tabs.ts` / `src/popout.ts`：タブ取得ブリッジ、ポップアウトの対象解決と作成。
- `src/side.ts` / `src/storage.ts`：ブラウザ差異の吸収と共通ヘルパー。
- `src/messaging/`：公開型、JSON検証、送信・待機処理、チャンネルのルーティング。
- `src/disposables.ts` / `src/facade.ts`：解除処理の管理、ネイティブAPIを変更しないラッパー。
- `demo/src/operations.ts`：ユーザー操作を維持した実行と、ボタンごとの実行中状態の管理。

ネイティブメッセージの受信リスナーは `createWebExt()` のインスタンスごとに1つを共有し、handlerまたはMAIN world中継が存在する間だけ登録します。ストレージの監視とactionクリックの解除関数は、繰り返し呼んでも解除処理を重複実行しません。

### 検証範囲

テストでは API のモックによる動作・境界条件・解除処理と、公開用スクリプトの出力を確認します。実際の表示・ユーザー操作の有効期間・権限は、ブラウザでの確認が必要です。
