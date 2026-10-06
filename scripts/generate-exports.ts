import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface OutputOptions {
  outDir: string
  chunkDir: string
}
interface ExportTarget {
  types: string
  import: string
}

const trailingSlashes = /\/+$/
function portablePath(value: string) {
  return value.replaceAll('\\', '/').replace(trailingSlashes, '')
}

// ビルド出力から、実在する JavaScript と型宣言の組だけを明示的に公開する。
export function createExportMap(
  outputFiles: Iterable<string>,
  options: OutputOptions
): Record<string, ExportTarget> {
  const outDir = portablePath(options.outDir)
  const chunkDir = portablePath(options.chunkDir)
  const files = new Set(Array.from(outputFiles, portablePath))
  const entries = [...files]
    .filter((file) => file.endsWith('.js') && !file.startsWith(`${chunkDir}/`))
    .sort()
  if (!entries.length) throw new Error('No JavaScript entry outputs found')
  if (!entries.includes('index.js'))
    throw new Error('Missing root output: index.js')

  const exports = new Map<string, ExportTarget>()
  for (const file of entries) {
    const declaration = `${file.slice(0, -3)}.d.ts`
    if (!files.has(declaration))
      throw new Error(`Missing declaration output: ${declaration}`)
    const stem = file.slice(0, -3)
    const alias =
      stem === 'index'
        ? '.'
        : `./${stem.endsWith('/index') ? stem.slice(0, -6) : stem}`
    if (alias.includes('*')) throw new Error(`Invalid export path: ${alias}`)
    if (exports.has(alias)) throw new Error(`Conflicting export path: ${alias}`)
    exports.set(alias, {
      types: `./${outDir}/${declaration}`,
      import: `./${outDir}/${file}`,
    })
  }
  return Object.fromEntries(
    [...exports].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
}

async function collectOutputFiles(
  directory: string,
  chunkDir: string
): Promise<string[]> {
  const files: string[] = []
  const chunks = portablePath(chunkDir)
  async function visit(relativeDirectory: string) {
    for (const entry of await fs.readdir(
      path.join(directory, relativeDirectory),
      {
        withFileTypes: true,
      }
    )) {
      const relativeFile = path.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        if (portablePath(relativeFile) !== chunks) await visit(relativeFile)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))
      )
        files.push(relativeFile)
    }
  }
  await visit('')
  return files
}

async function formatPackageJson(packageJsonPath: string) {
  // シェルを介さず引数を渡し、Windows でもローカルの Biome を同じ方法で実行する。
  const biome = fileURLToPath(import.meta.resolve('@biomejs/biome/bin/biome'))
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [biome, 'format', '--write', packageJsonPath],
      {
        stdio: 'inherit',
        shell: false,
      }
    )
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Biome formatting failed: ${signal ?? code}`))
    })
  })
}

export async function generateExports(
  options: OutputOptions & { packageJsonPath: string },
  format: (packageJsonPath: string) => Promise<void> = formatPackageJson
) {
  const packageJsonPath = path.resolve(options.packageJsonPath)
  const packageDirectory = path.dirname(packageJsonPath)
  const outputDirectory = path.resolve(packageDirectory, options.outDir)
  const exports = createExportMap(
    await collectOutputFiles(outputDirectory, options.chunkDir),
    options
  )
  const root = exports['.']!
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
  packageJson.exports = exports
  packageJson.module = root.import
  packageJson.types = root.types

  // 検証・整形がすべて成功するまで既存の package.json を上書きしない。
  const staging = await fs.mkdtemp(
    path.join(packageDirectory, '.generate-exports-')
  )
  try {
    const stagedPackageJsonPath = path.join(staging, 'package.json')
    await fs.writeFile(
      stagedPackageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`
    )
    await format(stagedPackageJsonPath)
    await fs.rename(stagedPackageJsonPath, packageJsonPath)
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

// インポート時には設定の読み込み・ファイル更新・プロセス起動を行わない。
if (import.meta.main) {
  const { chunkDir, outDir } = await import('../tsdown.config')
  await generateExports({
    packageJsonPath: fileURLToPath(new URL('../package.json', import.meta.url)),
    outDir,
    chunkDir,
  })
}
