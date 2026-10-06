/**
 * 現在のブラウザ・実行コンテキストに、操作に必要なAPIや機能がない場合のエラー。
 *
 * @remarks
 * 権限不足などのネイティブエラーを一律にこの型へ変換するものではありません。
 * `StorageHelpers.watch()` / `MessageChannel.handle()` では同期的に送出し、`MessageChannel.send()` など
 * Promiseを返す操作では拒否理由になります。捕捉方法は呼び出すAPIに従ってください。
 */
export class UnsupportedOperationError extends Error {
  /**
   * 利用できない操作名を含むエラーを作成します。
   * @param operation - ライブラリ内の操作識別子（例: `storage.watch`）。
   */
  constructor(
    /** 利用できなかった操作の識別子。 */
    readonly operation: string
  ) {
    super(`webext: ${operation} is unavailable in this browser or context`)
    this.name = 'UnsupportedOperationError'
  }
}

/**
 * メッセージの応答待機が送信側の期限を超過した場合のエラー。
 *
 * @remarks
 * `channel.send()` のPromiseの拒否理由です。受信側の処理やネイティブ通信が停止したことは意味しません。
 * 不正な待機上限の指定はこの型ではなく `TypeError` になります。
 */
export class MessageTimeoutError extends Error {
  /**
   * 応答待機の上限を含むエラーを作成します。
   * @param timeoutMs - 超過した待機上限（ミリ秒）。このコンストラクター自体は値を検証しません。
   */
  constructor(
    /** 送信側で設定した応答待機の上限（ミリ秒）。 */
    readonly timeoutMs: number
  ) {
    super(`webext: message did not respond within ${timeoutMs}ms`)
    this.name = 'MessageTimeoutError'
  }
}

/**
 * 受信側のハンドラーの失敗を送信側へ伝えるエラー。
 *
 * @remarks
 * ハンドラーの同期例外・Promiseの拒否・応答のJSON化失敗は、`channel.send()` のPromiseをこの型で拒否します。
 * `name` は `RemoteError`、元の名前は `remoteName`、失敗内容は継承した `message` に保持します。
 * 元の例外オブジェクト・スタック・独自プロパティは転送しません。Error以外の例外値は名前を `Error` として
 * 文字列化し、文字列化も失敗した場合は `Error` / `Remote handler failed` にフォールバックします。
 */
export class RemoteError extends Error {
  /**
   * 受信側から転送された名前とメッセージでエラーを作成します。
   * @param message - 受信側のエラーメッセージ、または例外値を文字列化した内容。
   * @param remoteName - 受信側の例外名。名前を取得できない場合は `Error`。
   */
  constructor(
    message: string,
    /** 受信側で正規化した例外名。送信側の `name` とは異なります。 */
    readonly remoteName: string
  ) {
    super(message)
    this.name = 'RemoteError'
  }
}

/**
 * タブIDが非負の安全な整数であることだけを検証します。
 * @param id - 検証するタブID。タブの存在やアクセス可否は確認しません。
 * @returns 戻り値はありません。
 * @throws {TypeError} 非負の安全な整数でなければ同期的に送出します。
 * @internal
 */
export function assertTabId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 0) throw new TypeError('Invalid tab ID')
}
