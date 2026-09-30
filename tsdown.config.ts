import { defineConfig } from 'tsdown'

export const outDir: string = 'dist'
export const chunkDir: string = 'chunks'

export default defineConfig({
  outDir,
  entry: 'src/**/*.ts',
  format: 'esm',
  target: 'esnext',
  platform: 'browser',
  dts: true,
  deps: {
    onlyBundle: false,
    neverBundle: ['webextension-polyfill'],
  },
  outputOptions: {
    chunkFileNames: `${chunkDir}/[name]-[hash].js`,
  },
})
