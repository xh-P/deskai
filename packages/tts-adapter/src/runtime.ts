import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadTtsRuntime(root: string, assetRoot: string) {
  const file = path.resolve(process.env.DESKAI_TTS_CONFIG ?? path.join(root, 'config/voice/output-runtime.json'));
  const config = JSON.parse(await readFile(file, 'utf8'));
  const { python, repository, ffmpegBin, modelDirectory, referenceDirectory, registry, defaultVoiceId } = config;
  if (![python, repository, ffmpegBin, modelDirectory, referenceDirectory, registry, defaultVoiceId]
    .every(value => typeof value === 'string' && value.trim())) throw new Error('INVALID_TTS_CONFIG');
  const executable = path.resolve(assetRoot, python);
  const ffmpeg = path.resolve(assetRoot, ffmpegBin, 'ffmpeg.exe');
  const required = [
    executable,
    path.resolve(assetRoot, repository, 'GPT_SoVITS/TTS_infer_pack/TTS.py'),
    ffmpeg,
    path.resolve(assetRoot, modelDirectory, registry),
    path.resolve(assetRoot, referenceDirectory),
  ];
  return { file, executable, ffmpeg, defaultVoiceId: defaultVoiceId as string, required };
}

export async function inspectTtsAssets(root: string, assetRoot: string): Promise<{ ready: boolean; missing: string[] }> {
  try {
    const { required } = await loadTtsRuntime(root, assetRoot);
    const results = await Promise.allSettled(required.map(file => access(file)));
    const missing = required.filter((_, index) => results[index].status === 'rejected')
      .map(file => path.relative(assetRoot, file));
    return { ready: !missing.length, missing };
  } catch (error) {
    return { ready: false, missing: [error instanceof Error && error.message === 'INVALID_TTS_CONFIG'
      ? error.message : 'config/voice/output-runtime.json'] };
  }
}
