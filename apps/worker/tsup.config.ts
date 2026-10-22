import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  clean: true,
  // The workspace packages export TypeScript sources, so they are bundled in;
  // every other dependency stays external and is installed in the image.
  noExternal: [/^@vpsm\//],
})
