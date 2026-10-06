import { expect, mock, test } from 'bun:test'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createExportMap, generateExports } from '../scripts/generate-exports'

const options = { outDir: 'dist', chunkDir: 'chunks' }
const rootOutputs = ['index.js', 'index.d.ts']
const originalPackage =
  '{"name":"fixture","module":"./old.js","types":"./old.d.ts","exports":{".":"./old.js"},"custom":true}\n'

async function fixture(files: string[]) {
  // サンドボックスでも書き込めるように、一時ディレクトリはプロジェクト内に作る。
  const directory = await mkdtemp(join(import.meta.dir, 'generate exports ; '))
  const packageJsonPath = join(directory, 'package.json')
  try {
    await writeFile(packageJsonPath, originalPackage)
    await mkdir(join(directory, 'dist'))
    for (const file of files) {
      const location = join(directory, 'dist', file)
      await mkdir(dirname(location), { recursive: true })
      await writeFile(location, 'export {}\n')
    }
    return {
      directory,
      packageJsonPath,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test('single-entry output exposes only the root with types before import', () => {
  const exports = createExportMap(rootOutputs, options)
  expect(exports).toEqual({
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  })
  expect(Object.keys(exports['.']!)).toEqual(['types', 'import'])
})

test('nested outputs use explicit aliases and skip chunks and orphan declarations', () => {
  const exports = createExportMap(
    [
      ...rootOutputs,
      'storage.js',
      'storage.d.ts',
      'messaging/index.js',
      'messaging/index.d.ts',
      'messaging/channel.js',
      'messaging/channel.d.ts',
      'messaging/internal/request.js',
      'messaging/internal/request.d.ts',
      'chunks/runtime-123.js',
      'chunks/nested/shared.js',
      'types-only.d.ts',
    ],
    options
  )
  expect(Object.keys(exports)).toEqual([
    '.',
    './messaging',
    './messaging/channel',
    './messaging/internal/request',
    './storage',
  ])
  expect(exports['./messaging']).toEqual({
    types: './dist/messaging/index.d.ts',
    import: './dist/messaging/index.js',
  })
  expect(exports['./messaging/internal/request']).toEqual({
    types: './dist/messaging/internal/request.d.ts',
    import: './dist/messaging/internal/request.js',
  })
  expect(Object.keys(exports).some((key) => key.includes('*'))).toBe(false)
})

test('mapping is deterministic with Windows separators and shuffled inputs', () => {
  const files = [
    ...rootOutputs,
    'z.js',
    'z.d.ts',
    'nested/a.js',
    'nested/a.d.ts',
    'chunks/internal.js',
  ]
  const expected = createExportMap(files, {
    outDir: 'build/esm',
    chunkDir: 'chunks',
  })
  const actual = createExportMap(
    files.toReversed().map((file) => file.replaceAll('/', '\\')),
    { outDir: 'build\\esm', chunkDir: 'chunks\\' }
  )
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
  expect(JSON.stringify(actual)).not.toContain('\\')
})

test('custom nested chunk directory does not hide similarly named public outputs', () => {
  const exports = createExportMap(
    [
      ...rootOutputs,
      'private/chunks/shared.js',
      'chunks-public.js',
      'chunks-public.d.ts',
    ],
    { ...options, chunkDir: 'private\\chunks' }
  )
  expect(Object.keys(exports)).toEqual(['.', './chunks-public'])
})

test('incomplete output fails instead of advertising missing files', () => {
  for (const files of [[], ['index.d.ts'], ['chunks/shared.js']])
    expect(() => createExportMap(files, options)).toThrow(
      'No JavaScript entry outputs'
    )
  expect(() => createExportMap(['other.js', 'other.d.ts'], options)).toThrow(
    'Missing root output'
  )
  expect(() => createExportMap(['index.js'], options)).toThrow(
    'Missing declaration output: index.d.ts'
  )
  expect(() =>
    createExportMap([...rootOutputs, 'nested/a.js'], options)
  ).toThrow('Missing declaration output: nested/a.d.ts')
})

test('colliding aliases and wildcard filenames fail rather than overwrite or broaden exports', () => {
  expect(() =>
    createExportMap(
      [
        ...rootOutputs,
        'nested.js',
        'nested.d.ts',
        'nested/index.js',
        'nested/index.d.ts',
      ],
      options
    )
  ).toThrow('Conflicting export path: ./nested')
  expect(() =>
    createExportMap([...rootOutputs, 'nested/*.js', 'nested/*.d.ts'], options)
  ).toThrow('Invalid export path')
})

test('generation preserves unrelated package fields and updates stale root paths', async () => {
  const f = await fixture([
    ...rootOutputs,
    'nested/util.js',
    'nested/util.d.ts',
    'chunks/shared.js',
  ])
  try {
    const format = mock(async (_path: string) => {})
    await generateExports(
      { ...options, packageJsonPath: f.packageJsonPath },
      format
    )
    const updated = JSON.parse(await readFile(f.packageJsonPath, 'utf8'))
    expect(updated).toEqual({
      name: 'fixture',
      custom: true,
      module: './dist/index.js',
      types: './dist/index.d.ts',
      exports: createExportMap(
        [...rootOutputs, 'nested/util.js', 'nested/util.d.ts'],
        options
      ),
    })
    expect(format).toHaveBeenCalledTimes(1)
    expect((await readdir(f.directory)).sort()).toEqual([
      'dist',
      'package.json',
    ])
  } finally {
    await f.cleanup()
  }
})

test('invalid or missing build outputs never clobber the original package or run formatting', async () => {
  for (const files of [
    [],
    ['other.js', 'other.d.ts'],
    ['index.js'],
    [...rootOutputs, 'nested/a.js'],
  ]) {
    const f = await fixture(files)
    try {
      const format = mock(async (_path: string) => {})
      await expect(
        generateExports(
          { ...options, packageJsonPath: f.packageJsonPath },
          format
        )
      ).rejects.toThrow()
      expect(await readFile(f.packageJsonPath, 'utf8')).toBe(originalPackage)
      expect(format).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  }
  const f = await fixture(rootOutputs)
  try {
    await rm(join(f.directory, 'dist'), { recursive: true })
    const format = mock(async (_path: string) => {})
    await expect(
      generateExports(
        { ...options, packageJsonPath: f.packageJsonPath },
        format
      )
    ).rejects.toThrow()
    expect(await readFile(f.packageJsonPath, 'utf8')).toBe(originalPackage)
    expect(format).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

test('formatting is awaited before replacement and failures leave the original untouched', async () => {
  const f = await fixture(rootOutputs)
  try {
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const generation = generateExports(
      { ...options, packageJsonPath: f.packageJsonPath },
      async (staged) => {
        expect(staged).not.toBe(f.packageJsonPath)
        started()
        await waiting
        const value = JSON.parse(await readFile(staged, 'utf8'))
        value.formatted = true
        await writeFile(staged, JSON.stringify(value))
      }
    )
    await entered
    expect(await readFile(f.packageJsonPath, 'utf8')).toBe(originalPackage)
    finish()
    await generation
    expect(
      JSON.parse(await readFile(f.packageJsonPath, 'utf8')).formatted
    ).toBe(true)

    const beforeFailure = await readFile(f.packageJsonPath, 'utf8')
    await expect(
      generateExports(
        { ...options, packageJsonPath: f.packageJsonPath },
        async () => {
          throw new Error('formatter failed')
        }
      )
    ).rejects.toThrow('formatter failed')
    expect(await readFile(f.packageJsonPath, 'utf8')).toBe(beforeFailure)
    expect((await readdir(f.directory)).sort()).toEqual([
      'dist',
      'package.json',
    ])
  } finally {
    await f.cleanup()
  }
})

test('the real formatter handles paths containing spaces and shell metacharacters', async () => {
  const f = await fixture(rootOutputs)
  try {
    await generateExports({ ...options, packageJsonPath: f.packageJsonPath })
    const updated = JSON.parse(await readFile(f.packageJsonPath, 'utf8'))
    expect(updated.exports).toEqual(createExportMap(rootOutputs, options))
    expect(await readFile(f.packageJsonPath, 'utf8')).toContain('\n  "name":')
  } finally {
    await f.cleanup()
  }
})

test('importing the script does not load build configuration, scan outputs, or modify package.json', async () => {
  const f = await fixture([])
  try {
    const scripts = join(f.directory, 'scripts')
    await mkdir(scripts)
    const script = join(scripts, 'generate-exports.ts')
    await copyFile(
      fileURLToPath(new URL('../scripts/generate-exports.ts', import.meta.url)),
      script
    )
    await writeFile(
      join(f.directory, 'tsdown.config.ts'),
      'throw new Error("configuration must not load on import")\n'
    )
    await rm(join(f.directory, 'dist'), { recursive: true })
    const imported = await import(pathToFileURL(script).href)
    expect(typeof imported.createExportMap).toBe('function')
    expect(typeof imported.generateExports).toBe('function')
    expect(await readFile(f.packageJsonPath, 'utf8')).toBe(originalPackage)
    expect((await readdir(f.directory)).sort()).toEqual([
      'package.json',
      'scripts',
      'tsdown.config.ts',
    ])
  } finally {
    await f.cleanup()
  }
})
