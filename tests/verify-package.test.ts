import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import {
  packedFilePaths,
  verifyPackage,
  verifyPackageTargets,
} from '../scripts/verify-package'

const metadata = {
  name: '@midra/webext',
  type: 'module',
  module: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  },
}
const files = new Set(['package.json', 'dist/index.js', 'dist/index.d.ts'])

function packOutput(paths: Iterable<string>) {
  return [{ files: [...paths].map((path) => ({ path })) }]
}

test('reads packed file lists from npm array and keyed JSON output', () => {
  const packages = packOutput(files)
  expect(packedFilePaths(JSON.stringify(packages))).toEqual(files)
  expect(
    packedFilePaths(JSON.stringify({ '@midra/webext': packages[0] }))
  ).toEqual(files)
})

test('rejects ambiguous pack output and unsafe file paths', () => {
  for (const value of [[], [...packOutput(files), ...packOutput(files)], [{}]])
    expect(() => packedFilePaths(JSON.stringify(value))).toThrow(
      'Expected one package'
    )
  for (const path of [
    '../index.js',
    '/index.js',
    'dist\\index.js',
    'dist/./index.js',
    'node_modules/private.js',
  ])
    expect(() => packedFilePaths(JSON.stringify(packOutput([path])))).toThrow(
      'Invalid package file path'
    )
})

test('valid root targets pass without changing package metadata', () => {
  const before = JSON.stringify(metadata)
  verifyPackageTargets(metadata, files)
  expect(JSON.stringify(metadata)).toBe(before)
})

test('missing JavaScript, declarations, and package metadata fail verification', () => {
  for (const missing of files) {
    const incomplete = new Set(files)
    incomplete.delete(missing)
    expect(() => verifyPackageTargets(metadata, incomplete)).toThrow(
      missing === 'package.json' ? 'package.json is missing' : 'is not packed'
    )
  }
})

test('legacy fields must match the exported root and both conditions are required', () => {
  expect(() =>
    verifyPackageTargets({ ...metadata, module: './old.js' }, files)
  ).toThrow('must match the root')
  expect(() =>
    verifyPackageTargets({ ...metadata, types: './old.d.ts' }, files)
  ).toThrow('must match the root')
  expect(() =>
    verifyPackageTargets({ ...metadata, exports: {} }, files)
  ).toThrow('Expected an ESM root')
  expect(() =>
    verifyPackageTargets({ ...metadata, type: 'commonjs' }, files)
  ).toThrow('Expected an ESM root')
})

test('checks every advertised target, not just the root', () => {
  const additional = {
    ...metadata,
    exports: {
      ...metadata.exports,
      './extra': { types: './dist/extra.d.ts', import: './dist/extra.js' },
    },
  }
  expect(() => verifyPackageTargets(additional, files)).toThrow(
    'Export ./extra (types) is not packed'
  )
  const complete = new Set([...files, 'dist/extra.d.ts', 'dist/extra.js'])
  verifyPackageTargets(additional, complete)
  for (const target of [
    'dist/extra.js',
    './../extra.js',
    './node_modules/extra.js',
  ])
    expect(() =>
      verifyPackageTargets(
        {
          ...additional,
          exports: {
            ...metadata.exports,
            './extra': { types: './dist/extra.d.ts', import: target },
          },
        },
        complete
      )
    ).toThrow('Invalid')
})

async function fixture() {
  const directory = await mkdtemp(join(import.meta.dir, 'verify package ; '))
  const packageJsonPath = join(directory, 'package.json')
  const original = JSON.stringify({
    ...metadata,
    version: '0.0.0',
    files: ['dist'],
    scripts: { prepack: 'node -e "throw new Error(\'prepack must not run\')"' },
  })
  try {
    await mkdir(join(directory, 'dist'))
    await writeFile(packageJsonPath, original)
    await writeFile(
      join(directory, 'dist/index.js'),
      `export const webext = {}
export function createWebExt() { throw new Error('WebExtension context required') }
export function createMainWorldStorage() {}
export function createMainWorldMessaging() {}
export class MessageTimeoutError extends Error {}
export class RemoteError extends Error {}
export class UnsupportedOperationError extends Error {}
`
    )
    await writeFile(
      join(directory, 'dist/index.d.ts'),
      `export interface StorageMigrationResult {
  readonly fromVersion: number
  readonly toVersion: number
  readonly appliedVersions: readonly number[]
}
export interface StorageMigration {
  readonly version: number
  readonly migrate: (context: {
    storage: {
      getValue<T>(key: string, fallback: T): Promise<T>
      setValue<T>(key: string, value: T): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
    readonly fromVersion: number
    readonly toVersion: number
  }) => void | Promise<void>
}
export interface StorageMigrator {
  migrate(migrations: readonly StorageMigration[], options?: { versionKey?: string }): Promise<StorageMigrationResult>
}
export interface NamespacedStorageArea<T> extends StorageMigrator {
  getValue<K extends keyof T>(key: K): Promise<T[K] | undefined>
  getValue<K extends keyof T>(key: K, fallback: T[K]): Promise<T[K]>
  setValue<K extends keyof T>(key: K, value: T[K]): Promise<void>
}
export interface MainWorldStorage {
  local: { namespace<T>(name: string): Omit<NamespacedStorageArea<T>, 'migrate'> }
}
export interface MessageChannel<S> {
  send<K extends keyof S>(name: K, request: S[K] extends { request: infer R } ? R : never):
    Promise<S[K] extends { response: infer R } ? R : never>
}
export interface WebExt {
  storage: { local: StorageMigrator & { namespace<T>(name: string): NamespacedStorageArea<T> } }
  messaging: { channel<S>(name: string): MessageChannel<S> }
}
export declare const webext: WebExt
export declare function createWebExt(options?: { context: string }): WebExt
export declare function createMainWorldStorage(options: { namespace: string }): MainWorldStorage
export declare function createMainWorldMessaging(options: { namespace: string }): unknown
export declare class MessageTimeoutError extends Error {}
export declare class RemoteError extends Error {}
export declare class UnsupportedOperationError extends Error {}
`
    )
    return {
      directory,
      async expectUnchanged() {
        expect(await readFile(packageJsonPath, 'utf8')).toBe(original)
        expect((await readdir(directory)).sort()).toEqual([
          'dist',
          'package.json',
        ])
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test('staged consumers pass without running prepack, changing metadata, or leaving artifacts', async () => {
  const f = await fixture()
  try {
    await verifyPackage(f.directory)
    await f.expectUnchanged()
  } finally {
    await f.cleanup()
  }
}, 30_000)

test('files excluded from the tarball fail even when they exist on disk', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, 'dist/.npmignore'), 'index.d.ts\n')
    await expect(verifyPackage(f.directory)).rejects.toThrow('is not packed')
    await rm(join(f.directory, 'dist/.npmignore'))
    await f.expectUnchanged()
  } finally {
    await f.cleanup()
  }
}, 30_000)

test('invalid declarations and missing runtime imports fail and clean up the staged consumer', async () => {
  const f = await fixture()
  try {
    const declarations = join(f.directory, 'dist/index.d.ts')
    const valid = await readFile(declarations, 'utf8')
    await writeFile(
      declarations,
      `${valid}\nexport type Broken = MissingType\n`
    )
    await expect(verifyPackage(f.directory)).rejects.toThrow('MissingType')
    await f.expectUnchanged()
    await writeFile(declarations, valid)
    await writeFile(
      join(f.directory, 'dist/index.js'),
      "import './missing.js'\n"
    )
    await expect(verifyPackage(f.directory)).rejects.toThrow('missing.js')
    await f.expectUnchanged()
  } finally {
    await f.cleanup()
  }
}, 30_000)
