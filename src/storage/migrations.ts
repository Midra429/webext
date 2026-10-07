import type { NamespacedStorageArea, StorageHelpers } from './index'

import { UnsupportedOperationError } from '../errors'

/** 移行中のストレージ操作。現在のスキーマにない旧キーも扱えます。 */
export type StorageMigrationArea = Pick<
  NamespacedStorageArea,
  'get' | 'set' | 'remove' | 'clear' | 'getValue' | 'setValue'
>

/** 1段階の移行に渡す情報。storageは対象領域または名前空間に限定されます。 */
export interface StorageMigrationContext {
  /** バージョンキーの書き換え・削除は禁止。clear()もそのキーを保持します。 */
  readonly storage: StorageMigrationArea
  /** この段階の開始時の保存バージョン。未保存なら0。 */
  readonly fromVersion: number
  /** この段階が成功した後に保存するバージョン。 */
  readonly toVersion: number
}

/** 正の安全な整数で識別する移行。バージョンの昇順で実行します。 */
export interface StorageMigration {
  readonly version: number
  /**
   * 完了後にのみバージョンを保存します。失敗・中断時の再実行に備え冪等にしてください。
   * 書き込みは即時に行われ、自動ロールバックはありません。
   */
  readonly migrate: (context: StorageMigrationContext) => void | Promise<void>
}

export interface StorageMigrationOptions {
  /**
   * 保存バージョンのキー。既定は `_webext_storage_version`。
   * 名前空間では接頭辞を自動付与します。データキーと衝突しない名前を選んでください。
   */
  versionKey?: string
}

export interface StorageMigrationResult {
  readonly fromVersion: number
  readonly toVersion: number
  /** 今回成功してバージョンを保存した段階。実行不要なら空配列。 */
  readonly appliedVersions: readonly number[]
}

/** 拡張コンテキストで明示的に実行するバージョン付き移行。 */
export interface StorageMigrator {
  /**
   * 保存バージョンより新しい段階だけを昇順で実行し、各成功後に進捗を保存します。
   * 最新の移行より新しい保存バージョンは拒否し、ダウングレードしません。
   * 空の移行一覧は保存バージョンを読むだけです。managed領域では利用できません。
   *
   * 同じネイティブ領域・実バージョンキーの呼び出しは、このJS環境内で直列化します。
   * 別コンテキスト・別端末との排他や一般の読み書きとのトランザクションはありません。
   * backgroundなど1つの書き込み元で実行し、完了を待ってからデータを利用してください。
   * コールバック内から同じキーの移行をawaitすると待機が循環するため避けてください。
   * 失敗時は例外をそのまま伝播し、先に成功した段階の進捗と途中の書き込みは残ります。
   */
  migrate(
    migrations: readonly StorageMigration[],
    options?: StorageMigrationOptions
  ): Promise<StorageMigrationResult>
}

type MigrationTarget = StorageMigrationArea & Pick<StorageHelpers, 'getKeys'>

const DEFAULT_VERSION_KEY = '_webext_storage_version'
// 保存済みバージョンは常にstorageから読む。ここでは実行中の待機だけを管理する。
const queues = new WeakMap<object, Map<string, Promise<void>>>()

function snapshotMigrations(migrations: readonly StorageMigration[]) {
  if (!Array.isArray(migrations))
    throw new TypeError('Storage migrations must be an array')
  const versions = new Set<number>()
  const steps = Array.from(migrations, (step) => {
    if (!step || typeof step !== 'object')
      throw new TypeError('Invalid storage migration')
    const { version, migrate } = step
    if (!Number.isSafeInteger(version) || version <= 0)
      throw new TypeError(
        'Storage migration versions must be positive safe integers'
      )
    if (typeof migrate !== 'function')
      throw new TypeError('Storage migration must have a migrate function')
    if (versions.has(version))
      throw new TypeError(`Duplicate storage migration version: ${version}`)
    versions.add(version)
    return { version, migrate }
  })
  return steps.sort((a, b) => a.version - b.version)
}

/** コールバックから進捗キーを壊したり、同じ移行を再帰呼び出ししたりしないための限定API。 */
function migrationArea(
  area: MigrationTarget,
  versionKey: string
): StorageMigrationArea {
  const assertDataKey = (key: string) => {
    if (key === versionKey)
      throw new TypeError('The storage migration version key is reserved')
  }
  return {
    get: (keys) => area.get(keys),
    async set(items) {
      if (Object.hasOwn(items, versionKey)) assertDataKey(versionKey)
      await area.set(items)
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) assertDataKey(key)
      await area.remove(keys)
    },
    async clear() {
      const keys = (await area.getKeys()).filter((key) => key !== versionKey)
      await area.remove(keys)
    },
    async getValue<T>(key: string, defaultValue?: T): Promise<T> {
      return area.getValue(key, defaultValue as T)
    },
    async setValue(key, value) {
      assertDataKey(key)
      await area.setValue(key, value)
    },
  }
}

/** @internal 同じ実領域・キーの移行を、別のラッパーや名前空間ハンドル間でも直列化します。 */
export function createMigrationRunner(
  identity: object,
  getArea: () => MigrationTarget,
  prefix = '',
  writable = true
): StorageMigrator['migrate'] {
  return async (migrations, options = {}) => {
    if (!writable)
      throw new UnsupportedOperationError('storage.migrate on managed')
    const steps = snapshotMigrations(migrations)
    const { versionKey: requestedVersionKey } = options
    const versionKey =
      requestedVersionKey === undefined
        ? DEFAULT_VERSION_KEY
        : requestedVersionKey
    if (typeof versionKey !== 'string' || !versionKey.trim())
      throw new TypeError('Storage migration versionKey must not be empty')
    const key = `${prefix}${versionKey}`
    let pending = queues.get(identity)
    if (!pending) {
      pending = new Map()
      queues.set(identity, pending)
    }
    const previous = pending.get(key)
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    pending.set(key, turn)
    try {
      if (previous) await previous
      const area = getArea()
      const values = await area.get(versionKey)
      const stored = Object.hasOwn(values, versionKey) ? values[versionKey] : 0
      if (
        typeof stored !== 'number' ||
        !Number.isSafeInteger(stored) ||
        stored < 0
      )
        throw new TypeError(
          'Stored storage migration version must be a non-negative safe integer'
        )
      const fromVersion = stored
      const latest = steps.at(-1)?.version
      if (latest !== undefined && fromVersion > latest)
        throw new Error(
          `Stored storage version ${fromVersion} is newer than migration version ${latest}`
        )
      const storage = migrationArea(area, versionKey)
      let toVersion = fromVersion
      const appliedVersions: number[] = []
      for (const step of steps) {
        if (step.version <= toVersion) continue
        await step.migrate({
          storage,
          fromVersion: toVersion,
          toVersion: step.version,
        })
        await area.setValue(versionKey, step.version)
        toVersion = step.version
        appliedVersions.push(toVersion)
      }
      return { fromVersion, toVersion, appliedVersions }
    } finally {
      release()
      if (pending.get(key) === turn) pending.delete(key)
      if (!pending.size) queues.delete(identity)
    }
  }
}
