# webext demo

ライブラリの主要な機能を実際の拡張コンテキストで試す、開発用のManifest V3拡張です。Chrome / Firefoxで画面とコードを共有し、manifestだけをビルド時に切り替えます。ライブラリは `../src` から直接バンドルするため、npm公開やライブラリの事前ビルドは不要です。

## ビルド

リポジトリのルートで:

```sh
bun run demo:build
```

生成先:

- Chrome: `demo/dist/chrome`
- Firefox: `demo/dist/firefox`

Bunとルートの依存関係が必要です。`demo/dist` は生成物としてGit管理対象外です。

## 読み込み

### Chrome（最新版推奨）

1. `chrome://extensions` を開き、デベロッパーモードを有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」で `demo/dist/chrome` を選択します。
3. 拡張アイコンをクリックして操作画面を開きます。

### Firefox（140以降）

1. `about:debugging#/runtime/this-firefox` を開きます。
2. 「一時的なアドオンを読み込む」で `demo/dist/firefox/manifest.json` を選択します。
3. 拡張アイコンをクリックして操作画面を開きます。
4. サイトアクセスを求められたら、試験サイトへのアクセスを許可します。

ソースやライブラリを変更したら再ビルドし、ブラウザ側で拡張を再読み込みしてください。コンテンツスクリプトを試すページも再読み込みが必要です。

## 試せる操作

| 画面 | 確認内容 |
| --- | --- |
| タブと実行環境 | `context`、`getCurrentActive()`、`getTarget()`、`getSelf()` |
| サイドパネル | 開閉、パス変更、表示状態、capabilities |
| ポップアウト | サイド・actionの別ウィンドウ化、リンクあり／なしのcontext |
| アイコン動作 | popupを一旦無効にして `side.bindActionClick()` を試し、サイドからpopupに戻す |
| ストレージ | 各領域の `demo` 名前空間で値保存・取得・削除、キー、使用量、変更監視 |
| 型付きメッセージ | backgroundのエコー応答、RemoteError、タイムアウト、AbortSignal |
| コンテンツスクリプト | backgroundブリッジ経由で自身／対象／アクティブタブを取得 |
| ページ上のMAIN worldパネル | 公開したlocalの `demo-main` 名前空間で読取・保存・削除・クリア・監視、非同期 `getCapabilities()`、未公開スコープの拒否 |
| 右クリックメニュー | `menus` の名前差吸収、タブ情報の記録、アイコンのOK表示 |

ストレージは `namespace('demo')` を使用し、操作時には `value` / `menu` のキーだけを指定します。実保存キーは従来と同じ `demo:value` / `demo:menu` です。画面に表示するキー一覧・使用量は `demo` 名前空間だけが対象です。

### おすすめの確認手順

1. `https://example.com/` または `https://example.org/` を開きます。
2. ポップアップの「ページ側で self / target / active を取得」を押します。`nativeTabsAvailable: false` でも各IDが取得できれば、ブリッジが動作しています。
3. 「サイドを別ウィンドウで開く」を押し、「環境を表示」「リンク先・対象タブ」でリンク情報を確認します。
4. 片方のウィンドウでストレージの監視を開始し、もう片方で同じ領域に保存・削除します。
5. エコー応答・RemoteError・タイムアウト・キャンセルをそれぞれ実行します。後ろ3つのエラーは意図した結果です。
6. Webページを右クリックし「webext demo: タブ情報を記録」を実行して、画面の「最後の記録を読む」で確認します。

### MAIN worldストレージの確認

`https://example.com/` / `https://example.org/` のページ上部に「webext demo: MAIN world storage」パネルが表示されます。拡張のポップアップとは別の、ページのMAIN worldで動くUIです。

1. ビルド済みの拡張を読み込み、サイトアクセスを許可して試験ページを再読み込みします。
2. 「読む」を押します。初回は `value: '(未保存)'`。`keys`、`bytes`、非同期 `getCapabilities()` の結果も確認できます。通信失敗時は画面のエラーとコンテンツスクリプトのコンソールを確認してください。
3. 「変更を監視」を押します。購読開始のログだけで、初期値の通知はありません。監視開始はローカル購読であり、公開範囲の確認ではありません。
4. 文字列を変更して「保存」を押し、`watch` の変更通知と「読む」の値を確認します。同じ値の再保存ではなく、違う文字列を使ってください。
5. 別の試験タブでも監視を開始し、片方で保存・削除して両方の変更通知を確認します。「監視を停止」後は、そのタブで通知されないことを確認します。
6. 「削除」で `value` キーを削除し、「読む」で既定値に戻ることを確認します。「名前空間をクリア」は `demo-main` 内だけを削除します（非アトミック）。
7. 「未公開scopeを読む（拒否）」を押します。`local.namespace('demo').getValue('menu')` は拒否されるのが正常です。右クリックメニューの `demo:menu` を公開するためのボタンではありません。
8. ページ移動で `pagehide` が発生すると、MAINクライアント・購読・UIとコンテンツ側の中継を破棄します。試験を再開するにはページを再読み込みします。

#### 実装例とビルド構成

`src/content.ts` はISOLATED worldで次の公開範囲を登録します。通常のデモ・メニューの `demo` ではなく、専用の `demo-main` を使っています。

```ts
const stopStorageBridge = webext.storage.bridgeMainWorld({
  namespace: 'demo-main-storage', // 通信用の名前空間
  scopes: [{ area: 'local', namespace: 'demo-main', writable: true }],
  onError: console.error,
})
```

`src/main.ts` は拡張APIを呼ばず、MAIN用クライアントだけを使います。

```ts
import { createMainWorldStorage } from '../../src'

const storage = createMainWorldStorage({
  namespace: 'demo-main-storage', // コンテンツ側と同じ値
  timeoutMs: 5_000,
})
const area = storage.local.namespace('demo-main') // データ用の名前空間
// 実際のデモでは、以下の要求はボタンをクリックしたときだけ実行する。
const capabilities = await area.getCapabilities() // 同期capabilitiesではない
const value = await area.getValue<string>('value', '(未保存)')
await area.setValue<string>('value', 'Hello from MAIN')
const stopWatch = area.watch<string>('value', (value, previous) => {
  console.log(previous, value)
})
// pagehideでstopWatch()とstorage.dispose()を呼ぶ。
```

`build.ts` は `main.ts` を独立した `main.js` のIIFEとしてバンドルし、両ブラウザの生成マニフェストに次の静的エントリーを追加します。Firefoxの最低バージョン140はマニフェストの `world: 'MAIN'` に対応しています。

```json
{
  "matches": ["https://example.com/*", "https://example.org/*"],
  "js": ["main.js"],
  "world": "MAIN",
  "run_at": "document_idle"
}
```

ISOLATED worldの `content.js` を先に宣言し、MAIN側は初期化時に要求を送らずクリックを待ちます。`main.js` も既存の生成アセット確認に含めています。動的な `eval`、インラインJS、追加の `scripting` 権限は不要です。入力・結果・エラーは `textContent` で表示し、HTMLとして解釈しません。監視とDOMイベントリスナーは `pagehide` で解除します。コンテンツ側は停止関数と `webext.dispose()` を呼びます（`webext.storage.dispose()` でもストレージ中継を停止できます）。

#### 公開範囲とセキュリティ

- `writable` の既定値は `false`。このデモは `local/demo-main` だけを明示的に書込可とします。`managed` は書込許可を指定しても読取専用です。
- クライアントにはlocal / sync / managed / sessionのハンドルがありますが、利用可能性を保証しません。未公開の領域・スコープへの操作や `getCapabilities()` は拒否されます。このデモはsync / managed / sessionを公開しません。
- コンテンツスクリプトから利用できないsessionをbackgroundへ中継する機能はありません。非対応のままです。
- `watch()` は権限を検証せずローカル購読を登録します。通知は中継登録後の変更のみで、初期値・過去のイベントは再送しません。停止・破棄で中継の監視とリスナーも解除します。
- 通信用 `demo-main-storage` とデータ用 `demo-main` は別物です。名前空間は空文字・`:` を含む文字列を禁止します。ストレージとメッセージングは別のWindow通信を使うため、両方の `bridgeMainWorld()` を併用できます。
- メッセージングと同じJSON制約があります。Date / Map / BigInt / 循環参照などは転送不可。オブジェクト内の `undefined` は省略されます。型引数は実行時検証ではありません。
- **ページは通信を観測・偽造できます。** origin / sourceの確認はバンドルしたMAINスクリプトの認証ではありません。ページも公開スコープを読み書きできる前提です。パネルには秘密情報を入力せず、スコープにも保存しないでください。

## 制約・注意

- 開く操作はクリックから直接呼びます。Chrome用の実ウィンドウIDは画面の初期化時に用意し、開く直前には非同期検索を挟みません。
- コンテンツスクリプトはexample.com / example.orgのHTTPSページのトップフレームのみです。ブラウザ内部ページでは動きません。
- popup内の `getSelf()` は通常 `undefined`。コンテンツスクリプト側のボタンで実タブを確認できます。
- actionのpopupを無効にしている間、`action.openPopout()` はパス未設定エラーになります。サイド側の「アイコンをポップアップに戻す」で復帰してください。
- パス変更で表示中のサイドが再読み込みされ、画面内のログ・監視がリセットされる場合があります。
- 未対応の操作は無効表示。managed領域は読取専用です。sessionはブラウザ終了で、localは削除しない限り残ります。syncに保存した値はブラウザ設定に従い同期される場合があります。
- Chromeの `isOpen()` はドキュメントの存在を観測します。`getBytesInUse()` の補完値は推定です。両方とも画面の結果に測定方式を表示します。
- ログは各画面内のみ・最大20件です。保存データは拡張のストレージにあり、メニュー操作でタブタイトルとURLもlocalの `demo` に記録します。MAIN用の `demo-main` はページに公開しているので、拡張専用の秘密領域として扱わないでください。デモ独自の外部送信や解析サービスはありません。

## 権限

- `storage`: 保存・監視のデモ。
- `tabs`: タブID・タイトル・URLの表示と、コンテンツスクリプトへの送信。
- `contextMenus`: 右クリックメニューのデモ。
- Chromeのみ `sidePanel`: サイドパネルの操作。
- コンテンツスクリプトの試験サイト以外へのホストアクセスは要求しません。

実ブラウザでの手動確認用です。公開ストアへの提出を目的とした拡張ではありません。
