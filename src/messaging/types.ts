import type Browser from 'webextension-polyfill'

/**
 * 1種類のメッセージの要求型と応答型。
 *
 * @remarks
 * 型の定義であり、実行時スキーマではありません。要求・応答の内容は利用側で検証してください。
 * 送受信値はJSON互換値に限定し、Firefoxのstructured cloneで送れる値より厳しく制限します。
 * 有限数・文字列・真偽値・`null`・配列・プレーンオブジェクトが対象で、Date・Map・BigInt・
 * 関数・循環参照などは拒否します。オブジェクト内の `undefined` は省略、疎配列の穴は `null` に変換し、
 * 配列要素として明示した `undefined` は拒否します。最上位の `undefined` は内部で `null` とフラグに
 * 符号化し、受信時に `undefined` に復元します。要求・応答とも同じ規則です。
 * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-sendMessage
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/sendMessage
 */
export interface MessageDefinition {
  /** 送信する要求の型。型指定だけでは受信値を実行時検証しません。 */
  request: unknown
  /** ハンドラーが返す応答の型。JSON互換性以外の実行時検証は行いません。 */
  response: unknown
}
/**
 * メッセージ名から要求型・応答型への対応表。
 *
 * @remarks 同じチャンネルの送受信側で共有する型であり、実行時の登録・検証は行いません。
 * @example
 * ```ts
 * interface Messages {
 *   greet: { request: { name: string }; response: string }
 * }
 * ```
 */
export type MessageSchema = Record<string, MessageDefinition>
/**
 * 送信先と送信側の応答待機を指定するオプション。
 *
 * @remarks
 * `tabId` がなければ自拡張への `runtime.sendMessage()`、あれば `tabs.sendMessage()` を使用します。
 * 外部拡張・Webページ宛ての送信は提供しません。対象フレーム・ドキュメントの存在と各オプションへの
 * 対応はネイティブAPIに従い、未対応の指定を代替しません。
 * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-sendMessage
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage
 */
export interface SendOptions {
  /**
   * 送信先コンテンツスクリプトを含むタブID。非負の安全な整数が必要です。
   * @remarks ネイティブの `tabs.sendMessage()` が使えるコンテキストと、対象タブの受信ハンドラーが必要です。
   * `tabs` 権限が一律に必須という意味ではありません。省略時はアクティブタブを検索せず、自拡張へ送信します。
   */
  tabId?: number
  /**
   * 対象フレームのID。`tabId` が必須です。`0` はトップレベルフレーム。
   * @remarks 値の有効性・対象の存在はネイティブAPIに従います。省略時はネイティブの既定の送信範囲です。
   * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage
   */
  frameId?: number
  /**
   * 対象ドキュメントのID。`tabId` と、ネイティブAPIのこのオプションへの対応が必要です。
   * @remarks 値・対象の有効性はネイティブAPIに従い、未対応環境での補完は行いません。
   * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage
   */
  documentId?: string
  /**
   * 送信側の待機上限（ミリ秒）。既定値は10,000、正の有限数で最大2,147,483,647。
   * @remarks 範囲外は送信前に `TypeError` でPromiseが拒否されます。期限超過は `MessageTimeoutError`。
   * 終了するのはローカルの待機だけで、受信側の処理や送信済みのネイティブ通信はキャンセルしません。
   */
  timeoutMs?: number
  /**
   * 送信側の待機を中止するシグナル。
   * @remarks 既に中止済みなら送信しません。中止時は `signal.reason`（なければ `AbortError`）で
   * Promiseが拒否されます。送信後の中止はローカルの待機だけを終了し、受信処理はキャンセルしません。
   */
  signal?: AbortSignal
}
/**
 * 同じ拡張内の名前付き要求・応答チャンネル。
 *
 * @typeParam Schema - メッセージ名ごとの要求型・応答型。実行時スキーマ検証は行いません。
 * @remarks
 * ファクトリーごとに単一の `runtime.onMessage` ルーターを共有し、ハンドラーがある間だけ登録します。
 * 受信は `sender.id === runtime.id` の内部メッセージに限定し、未登録のチャンネル・メッセージは扱いません。
 * この確認は要求内容や送信元URLの信頼性を保証しません。必要な検証はハンドラーで行ってください。
 * 1つの要求に応答するコンテキストは1つにしてください。複数の受信先が応答する場合の順序は保証しません。
 * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage
 */
export interface MessageChannel<
  Schema extends { [K in keyof Schema]: MessageDefinition },
> {
  /**
   * JSON互換の要求を送り、対応するハンドラーの応答を待ちます。
   *
   * @typeParam K - スキーマ内のメッセージ名。
   * @param type - 送受信側で共有するメッセージ名。
   * @param request - 要求値。直列化の制約は {@link MessageDefinition} を参照してください。
   * @param options - 送信先・待機上限・中止シグナル。
   * @returns 応答値で解決するPromise。応答型の実行時検証は行いません。
   * @throws {TypeError} 無効なタブID・待機上限、`tabId` なしのframe/document指定、非JSON互換の要求。
   * @throws {UnsupportedOperationError} タブ送信に必要なネイティブAPIが利用できない場合。
   * @throws {MessageTimeoutError} 応答待機の期限を超過した場合。
   * @throws {RemoteError} ハンドラーの例外・Promise拒否、または応答のJSON化失敗。
   * @throws 破棄済みチャンネル・非互換の応答・ネイティブ通信エラー・シグナル中止理由。
   * @remarks
   * 上記の失敗はすべて戻り値のPromiseの拒否です（同期例外ではありません）。受信先がない場合も成功扱いにしません。
   * `tabId` なしの送信は送信元自身を除く拡張コンテキスト宛てで、コンテンツスクリプト宛てではありません。
   * コンテンツスクリプトへは `tabId` を指定してください。待機の中止は受信処理を停止しません。
   * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-sendMessage
   * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/sendMessage
   */
  send<K extends keyof Schema & string>(
    type: K,
    request: Schema[K]['request'],
    options?: SendOptions
  ): Promise<Schema[K]['response']>
  /**
   * 1種類のメッセージを処理するハンドラーを登録します。
   *
   * @typeParam K - スキーマ内のメッセージ名。
   * @param type - 処理するメッセージ名。同じチャンネル内で重複登録はできません。
   * @param handler - 要求値とネイティブのMessageSenderを受け取り、JSON互換の応答値またはそのPromiseを返す関数。
   * @returns この登録だけを解除する関数。繰り返し呼んでも一度だけ解除し、後続の再登録は解除しません。
   * @throws {UnsupportedOperationError} `runtime.onMessage` が利用できない場合に同期的に送出します。
   * @throws 破棄済みチャンネル・同じメッセージ名の重複登録は同期例外です。
   * @remarks
   * 受信イベント内でハンドラーを同期的に呼び、その結果をawaitしてcallbackで応答します。
   * Chrome / Firefoxとも内部リスナーは `true` を返して非同期応答を維持します。
   * ハンドラーの例外は送信側で `RemoteError` となります。要求値・senderの追加検証は利用側の責任です。
   * backgroundでは再起動時にも登録されるようトップレベルで呼んでください。
   * @example
   * ```ts
   * const channel = webext.messaging.channel<Messages>('app/background')
   * const stop = channel.handle('greet', ({ name }) => `Hello, ${name}`)
   * // 別コンテキストで同名チャンネルを作成し、send('greet', { name: 'Midra' })
   * stop()
   * ```
   * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#event-onMessage
   * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage
   */
  handle<K extends keyof Schema & string>(
    type: K,
    handler: (
      request: Schema[K]['request'],
      sender: Browser.Runtime.MessageSender
    ) => Schema[K]['response'] | Promise<Schema[K]['response']>
  ): () => void
  /**
   * このチャンネルの全ハンドラーを解除し、このオブジェクトを終端的に破棄します。
   *
   * @returns 戻り値はありません。繰り返し呼べます。
   * @remarks
   * 以後の `send()` はPromiseの拒否、`handle()` は同期例外になります。
   * ファクトリーが未破棄なら `messaging.channel(name)` で同名の新しいチャンネルを作れます。
   * 既に実行中のハンドラーや送信側の待機はキャンセルしません。
   */
  dispose(): void
}
/** 名前付きチャンネルを管理する、WebExtインスタンスごとのメッセージングファクトリー。 */
export interface Messaging {
  /**
   * 名前に対応するチャンネルを取得・作成します。
   *
   * @typeParam Schema - 送受信側で共有する型。同じ名前に異なる型を指定しても実行時に検出しません。
   * @param name - チャンネル名。空文字・空白のみは禁止で、それ以外は空白も含め完全一致で識別します。
   * @returns 同じファクトリー内では、同名の未破棄チャンネルを再利用します。
   * @throws {TypeError} 名前が空文字・空白のみなら同期的に送出します。
   * @throws ファクトリーが破棄済みなら同期例外です。
   * @remarks 取得だけでは受信リスナーを登録しません。送受信側で同じ名前とスキーマを共有してください。
   * @example
   * ```ts
   * const channel = webext.messaging.channel<Messages>('app/background')
   * const greeting = await channel.send('greet', { name: 'Midra' })
   * ```
   */
  channel<Schema extends { [K in keyof Schema]: MessageDefinition }>(
    name: string
  ): MessageChannel<Schema>
  /**
   * 全チャンネルと共有ルーターを解除し、ファクトリーを終端的に破棄します。
   *
   * @returns 戻り値はありません。繰り返し呼べます。
   * @remarks
   * `webext.dispose()` でも呼ばれます。破棄後は `channel()` を呼べません。
   * 再利用には `createWebExt()` で新しいインスタンスを作成してください。
   * 送信済みの待機や実行中の受信処理をキャンセルするものではありません。
   */
  dispose(): void
}

/** ネイティブAPIの注入に使う内部インターフェース。 @internal */
export interface MessagingApi {
  /** 内部メッセージの送信・送信元ID確認・受信登録に使うネイティブruntime API。 */
  runtime: Pick<Browser.Runtime.Static, 'id' | 'sendMessage' | 'onMessage'>
  /** 利用可能な場合のみ指定する、タブ宛て送信のネイティブAPI。 */
  tabs?: Pick<Browser.Tabs.Static, 'sendMessage'>
}

/** 共有ルーターが保持する、スキーマを消去した内部ハンドラー型。 @internal */
export type Handler = (
  request: unknown,
  sender: Browser.Runtime.MessageSender
) => unknown
