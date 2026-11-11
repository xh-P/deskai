import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const cache = path.join(root, '.cache/character-knowledge');
const service = path.join(root, 'services/character-knowledge');
const venv = path.join(cache, 'venv');
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const model = 'https://huggingface.co/intfloat/multilingual-e5-small/resolve/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx';
const files = {
  'model.onnx': 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', OMP_NUM_THREADS: '2' } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

await mkdir(path.join(cache, 'model'), { recursive: true });
if (!existsSync(python)) await run('uv', ['venv', '--python', '3.12', venv]);
await run('uv', ['pip', 'install', '--python', python, '-r', path.join(service, 'requirements.txt')]);
for (const [name, expected] of Object.entries(files)) {
  const file = path.join(cache, 'model', name);
  if (existsSync(file) && await digest(file) === expected) continue;
  const proxy = process.env.DESKAI_KNOWLEDGE_DOWNLOAD_PROXY;
  await run('curl', [...(proxy ? ['--proxy', proxy] : []), '--fail', '--location', '--retry', '2', '--max-time', '360',
    '--output', `${file}.part`, `${model}/${name}`]);
  if (await digest(`${file}.part`) !== expected) throw new Error(`Model checksum mismatch: ${name}`);
  await rename(`${file}.part`, file);
}
await run(python, [path.join(service, 'knowledge.py'), 'build', path.join(root, 'config/character-knowledge'), cache]);
