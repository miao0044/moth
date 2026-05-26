import { build } from 'esbuild';

build({
  entryPoints: ['src/editor/index.js'],
  bundle: true,
  format: 'cjs',
  outfile: 'dist/editor.bundle.js',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
}).catch(() => process.exit(1));
