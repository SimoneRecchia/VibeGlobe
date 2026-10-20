// Bundles code the way a consumer's Vite build would, without writing files, for size and tree-shaking checks.
import { gzipSync } from 'node:zlib';
import { build, type Rolldown } from 'vite';
import { ROOT_DIR } from './workspace.ts';

const ENTRY_ID = '\0vge-bundle-entry';

export interface BundleResult {
  code: string;
  gzipBytes: number;
  /** Absolute paths of the modules that contributed code to the bundle. */
  modules: string[];
}

/** Minifies and tree-shakes `entryCode` (an ES module importing published packages from their built `dist`). */
export async function bundle(
  entryCode: string,
  external: (id: string) => boolean = () => false,
): Promise<BundleResult> {
  const output = await build({
    root: ROOT_DIR,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'vge-bundle-entry',
        resolveId: (id) => (id === ENTRY_ID ? id : undefined),
        load: (id) => (id === ENTRY_ID ? entryCode : undefined),
      },
    ],
    build: {
      write: false,
      minify: true,
      rollupOptions: { input: ENTRY_ID, external, preserveEntrySignatures: 'strict' },
    },
  });
  const outputs = (Array.isArray(output) ? output : [output]) as Rolldown.RolldownOutput[];
  const chunks = outputs
    .flatMap((result) => result.output)
    .filter((item): item is Rolldown.OutputChunk => item.type === 'chunk');
  const code = chunks.map((chunk) => chunk.code).join('\n');
  const modules = chunks.flatMap((chunk) =>
    Object.entries(chunk.modules)
      .filter(([, info]) => info.renderedLength > 0)
      .map(([id]) => id),
  );
  return { code, gzipBytes: gzipSync(code, { level: 9 }).length, modules };
}
