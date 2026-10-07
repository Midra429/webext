import { execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

interface PackageMetadata {
  name: string
  type: string
  module: string
  types: string
  exports: Record<string, { types: string; import: string }>
}

const execute = promisify(execFile)
const projectDirectory = fileURLToPath(new URL('../', import.meta.url))

function packageFile(value: string) {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    value
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || part === 'node_modules'
      )
  )
    throw new Error(`Invalid package file path: ${value}`)
  return value
}

export function packedFilePaths(output: string): Set<string> {
  // npm versions return either an array or a map keyed by package name.
  const packages = Object.values(JSON.parse(output)) as {
    files: { path: string }[]
  }[]
  if (packages.length !== 1 || !Array.isArray(packages[0]?.files))
    throw new Error('Expected one package from npm pack --dry-run')
  return new Set(packages[0].files.map((file) => packageFile(file.path)))
}

export function verifyPackageTargets(
  metadata: PackageMetadata,
  files: ReadonlySet<string>
) {
  const root = metadata.exports?.['.']
  if (metadata.type !== 'module' || !root?.types || !root.import)
    throw new Error('Expected an ESM root export with types and import targets')
  if (metadata.module !== root.import || metadata.types !== root.types)
    throw new Error('module and types must match the root export targets')
  if (!files.has('package.json'))
    throw new Error('package.json is missing from the packed files')

  for (const [alias, conditions] of Object.entries(metadata.exports)) {
    for (const condition of ['types', 'import'] as const) {
      const target = conditions[condition]
      if (typeof target !== 'string' || !target.startsWith('./'))
        throw new Error(`Invalid ${condition} target for ${alias}: ${target}`)
      const file = packageFile(target.slice(2))
      if (!files.has(file))
        throw new Error(
          `Export ${alias} (${condition}) is not packed: ${target}`
        )
    }
  }
}

export async function verifyPackage(packageDirectory = projectDirectory) {
  const packageJsonPath = path.join(packageDirectory, 'package.json')
  const originalPackageJson = await readFile(packageJsonPath, 'utf8')
  const metadata: PackageMetadata = JSON.parse(originalPackageJson)
  // Suppress lifecycle hooks so verification inside prepack cannot recurse.
  const { stdout } = await execute(
    'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: packageDirectory, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
  )
  const files = packedFilePaths(stdout)
  verifyPackageTargets(metadata, files)

  const staging = await mkdtemp(path.join(packageDirectory, '.verify-package-'))
  try {
    const installedPackage = path.join(staging, 'node_modules', metadata.name)
    // Only packed files are visible to the consumer; src and its aliases are absent.
    for (const file of files) {
      const destination = path.join(installedPackage, file)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(path.join(packageDirectory, file), destination)
    }
    await writeFile(
      path.join(staging, 'package.json'),
      '{"private":true,"type":"module"}\n'
    )
    await copyFile(
      fileURLToPath(
        new URL('./fixtures/package-types.ts.txt', import.meta.url)
      ),
      path.join(staging, 'package-types.ts')
    )
    await copyFile(
      fileURLToPath(new URL('./fixtures/package-runtime.mjs', import.meta.url)),
      path.join(staging, 'package-runtime.mjs')
    )
    await writeFile(
      path.join(staging, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          lib: ['ESNext', 'DOM', 'DOM.Iterable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: [],
          strict: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          skipLibCheck: false,
          noEmit: true,
        },
        files: ['package-types.ts'],
      })
    )
    const compiler = path.join(
      path.dirname(
        fileURLToPath(import.meta.resolve('typescript/package.json'))
      ),
      'bin/tsc'
    )
    for (const args of [
      [compiler, '--project', path.join(staging, 'tsconfig.json')],
      [path.join(staging, 'package-runtime.mjs')],
    ]) {
      try {
        await execute('node', args, {
          cwd: staging,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string }
        throw new Error(
          `Package consumer verification failed:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
          { cause: error }
        )
      }
    }
    if ((await readFile(packageJsonPath, 'utf8')) !== originalPackageJson)
      throw new Error('Package metadata changed during verification')
    console.log(
      'Verified packed export targets, consumer types, and ESM runtime imports'
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) await verifyPackage()
