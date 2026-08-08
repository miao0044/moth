import { build } from 'esbuild';

const browserBundle = {
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
};

try {
  await Promise.all([
    build({
      ...browserBundle,
      entryPoints: ['src/editor/index.js'],
      outfile: 'dist/editor.bundle.js',
    }),
    build({
      ...browserBundle,
      entryPoints: ['src/epub/index.js'],
      outfile: 'dist/epub.bundle.js',
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl' },
    }),
    build({
      entryPoints: ['src/fonts/index.css'],
      bundle: true,
      outfile: 'dist/fonts.css',
      assetNames: 'fonts/[name]-[hash]',
      loader: { '.woff': 'file', '.woff2': 'file' },
      minify: true,
    }),
  ]);
} catch {
  process.exit(1);
}
