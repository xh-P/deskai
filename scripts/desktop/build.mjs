import { build } from 'vite';
import { spawn } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '../..');
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Build exited ${code}`)));
});
export async function buildDesktop() {
  const vadDest = path.join(root, 'apps/desktop/renderer/public/vad');
  await mkdir(vadDest, { recursive: true });
  for (const file of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']) {
    await cp(path.join(root, 'node_modules/@ricky0123/vad-web/dist', file), path.join(vadDest, file));
  }
  for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    await cp(path.join(root, 'node_modules/onnxruntime-web/dist', file), path.join(vadDest, file));
  }
  for (const file of ['vad-LICENSE.txt', 'onnxruntime-LICENSE.txt']) {
    await cp(path.join(root, 'third_party/voice-runtime', file), path.join(vadDest, file));
  }
  await run(['node_modules/typescript/bin/tsc', '-p', 'apps/desktop/tsconfig.main.json']);
  await run(['node_modules/typescript/bin/tsc', '-p', 'apps/desktop/tsconfig.renderer.json']);
  await mkdir(path.join(root, '.cache/desktop-main'), { recursive: true });
  await writeFile(path.join(root, '.cache/desktop-main/package.json'), '{"type":"module"}\n');
  await build({ root: path.join(root, 'apps/desktop/renderer'), base: './',
    build: { outDir: path.join(root, '.cache/desktop-renderer'), emptyOutDir: true },
    resolve: { dedupe: ['onnxruntime-web'] } });
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await buildDesktop();
