import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Live2DLibrary } from '../../apps/desktop/src/live2d-library.ts';

test('imported Live2D bundles share metadata validation and restore their per-model settings', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'deskai-live2d-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelDir = path.join(root, 'model');
  const userData = path.join(root, 'profile');
  const core = 'placeholder for the library hash check';
  const json = (file: string, value: unknown) => writeFile(path.join(root, file), JSON.stringify(value));
  await Promise.all(['config', '.cache/live2d', 'model'].map(dir => mkdir(path.join(root, dir), { recursive: true })));
  await Promise.all([
    writeFile(path.join(root, '.cache/live2d/live2dcubismcore.min.js'), core),
    json('config/live2d-models.json', {
      core: { sha256: createHash('sha256').update(core).digest('hex') },
      bundled: [], samples: { models: [] },
    }),
    writeFile(path.join(modelDir, 'model.moc3'), 'MOC3'),
    writeFile(path.join(modelDir, 'texture.png'), ''),
    json('model/Loop.motion3.json', {
      Meta: { Duration: 2.5 },
      Curves: [{ Target: 'Parameter', Id: 'FinTurn' }, { Target: 'Parameter', Id: 'Buoyancy' }],
    }),
    json('model/model.physics3.json', {
      PhysicsSettings: [{ Output: [{ Destination: { Id: 'FinSway' } }, { Destination: { Id: 'TailSway' } }] }],
    }),
    json('model/model.cdi3.json', {
      Version: 3, Parts: [{ Id: 'PartFin', Name: '鳍' }], Parameters: [{ Id: 'FinTurn', Name: '鳍转动' }],
    }),
    json('model/model.layers.json', {
      layers: [{ id: 'MeshFin', name: '鳍片', shape: 'seamed', motion: ['FinTurn'], sway: ['FinSway', 'UnknownSway'] }],
      idle: {
        motion: { group: 'Swim', index: 0 }, tracks: { fin: ['FinTurn', 'Missing'] },
        groupNames: { fin: '游动' },
      },
    }),
    json('model/model.model3.json', {
      Version: 3,
      FileReferences: {
        Moc: 'model.moc3', Textures: ['texture.png'], DisplayInfo: 'model.cdi3.json', Physics: 'model.physics3.json',
        Motions: { Swim: [{ File: 'Loop.motion3.json' }] },
      },
    }),
  ]);

  const library = await Live2DLibrary.open(root, userData);
  const { catalog, id } = await library.import(path.join(modelDir, 'model.model3.json'));
  const model = catalog.models[0];
  assert.equal(model.source, 'local');
  assert.equal(model.display?.parts[0].name, '鳍');
  assert.equal(model.layers?.[0].name, '鳍片');
  assert.deepEqual(model.layers?.[0].sway, ['FinSway']);
  assert.deepEqual(model.idle?.tracks, { fin: ['FinTurn'], base: ['Buoyancy'] });
  assert.deepEqual(model.idle?.groupNames, { fin: '游动' });
  assert.ok(await library.asset(`${id}/model.cdi3.json`));
  assert.equal(await library.asset(`${id}/model.layers.json`), undefined);
  await library.apply({ personaId: 'persona', modelId: id, style: {
    ...model.style, idle: { speed: 1.25, fin: 0.8, missing: 1.6 },
    motionTracks: { FinTurn: { amplitude: 1.2, delay: 0.1 }, Missing: { amplitude: 1, delay: 0.1 },
      Buoyancy: { amplitude: 0.6, delay: 0.2 } },
    layerShapes: { MeshFin: { width: 1.02, height: 1, bend: 0.03 } },
    layerSway: { FinSway: { amplitude: 0.6, response: 1.15 } },
  } });

  const restored = (await Live2DLibrary.open(root, userData)).resolve('persona');
  assert.equal(restored?.id, id);
  assert.deepEqual(restored.style.idle, { speed: 1.25, fin: 0.8 });
  assert.deepEqual(restored.style.motionTracks, { FinTurn: { amplitude: 1.2, delay: 0.1 } });
  assert.deepEqual(restored.style.layerShapes, { MeshFin: { width: 1.02, height: 1, bend: 0.03 } });
  assert.deepEqual(restored.style.layerSway, { FinSway: { amplitude: 0.6, response: 1 } });

  await json('outside.cdi3.json', { Version: 3, Parts: [{ Id: 'Outside' }] });
  await writeFile(path.join(modelDir, 'plain.layers.json'), '{bad JSON');
  await json('model/plain.model3.json', {
    Version: 3, FileReferences: { Moc: 'model.moc3', Textures: ['texture.png'], DisplayInfo: '../outside.cdi3.json' },
  });
  const plain = await library.import(path.join(modelDir, 'plain.model3.json'));
  const fallback = plain.catalog.models.find(item => item.id === plain.id);
  assert.equal(fallback?.display, undefined);
  assert.equal(fallback?.layers, undefined);
  assert.equal(fallback?.warnings?.length, 2);
  const asset = await library.asset(`${plain.id}/plain.model3.json`);
  assert.ok(asset);
  assert.equal(JSON.parse(Buffer.from(asset.data).toString()).FileReferences.DisplayInfo, undefined);
  assert.equal(await library.asset(`${plain.id}/../outside.cdi3.json`), undefined);
});
