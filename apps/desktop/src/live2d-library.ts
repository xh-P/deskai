import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultLive2DLayerShape, defaultLive2DLayerSway, defaultLive2DStyle, defaultLive2DTrackTuning,
  live2DIdleGroups, live2DIdleLimits, live2DLayerLimits, live2DSetting, live2DTunableTracks, type Live2DApply, type Live2DCatalog, type Live2DIdleRig,
  type Live2DMotion, type Live2DProfile, type Live2DStyle } from '../../../packages/desktop-pet/src/live2d.ts';
import { displayInfo, idleRig, idleTrackIds, ids, layerRig, object, physicsOutputs } from './live2d-metadata.ts';

type Definition = { id: string; name: string; file: string; style?: Partial<Live2DStyle>;
  idle?: Live2DIdleRig; glassesParameter?: string; layerFile?: string };
type Config = { core: { sha256: string }; bundled: Definition[]; samples: { models: Definition[] } };
type Saved = { models: Definition[]; bindings: Live2DCatalog['bindings']; styles: Record<string, Live2DStyle> };
type Bundle = { file: string; root: string; definition: Definition; profile: Live2DProfile; references: Map<string, string>;
  entry: string; manifest: string };
const coreName = 'live2dcubismcore.min.js';
const MiB = 1024 * 1024;
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

function reference(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value) || /[:?#%\0]/.test(value)) throw new Error('模型资源引用无效。');
  const relative = value.replace(/\\/g, '/');
  if (relative.split('/').some(segment => !segment || segment === '.' || segment === '..' ||
    (process.platform === 'win32' && /[. ]$/.test(segment)))) throw new Error('模型资源必须位于模型目录内。');
  return relative;
}

async function modelResource(root: string, name: string, maxSize: number): Promise<string> {
  const target = await realpath(path.resolve(root, name));
  if (!inside(root, target)) throw new Error('模型资源必须位于模型目录内。');
  const info = await stat(target);
  if (!info.isFile() || info.size > maxSize) throw new Error(`模型资源不可用 ${name}`);
  return target;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
}

function layerTuning<K extends keyof typeof live2DLayerLimits>(input: unknown, ids: string[], defaults: Record<K, number>,
  allows: (id: string, key: K) => boolean = () => true) {
  const overrides = object(input);
  const entries = [...new Set(ids)].flatMap(id => {
    if (!Object.hasOwn(overrides, id)) return [];
    const patch = object(overrides[id]);
    const value = { ...defaults };
    let changed = false;
    for (const key of Object.keys(defaults) as K[]) {
      if (!allows(id, key)) continue;
      const n = patch[key];
      if (n === undefined) continue;
      const [min, max] = live2DLayerLimits[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`无效的图层设置 ${id} / ${key}`);
      value[key] = n;
      changed ||= n !== defaults[key];
    }
    return changed ? [[id, value] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function tuning(profile: Live2DProfile, input: unknown): Live2DStyle {
  const patch = object(input);
  const next = { ...defaultLive2DStyle };
  for (const [name, min, max] of [
    ['zoom', 0.75, 1.6], ['x', -0.35, 0.35], ['y', -0.35, 0.35], ['gaze', 0, 1], ['mouthGain', 0.3, 3],
  ] as const) {
    const value = patch[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`无效的外观设置 ${name}`);
    next[name] = value;
  }
  if (patch.frame === 'full') next.frame = 'full';
  if (profile.idle) {
    const idle = object(patch.idle);
    const values = ['speed', ...live2DIdleGroups(profile.idle)].map(key => {
      const override = live2DSetting(idle, key);
      const value = override === undefined ? 1 : override;
      const [min, max] = live2DIdleLimits[key === 'speed' ? 'speed' : 'amplitude'];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        throw new Error(`无效的待机设置 ${key}`);
      return [key, value] as const;
    });
    next.idle = { speed: 1, ...Object.fromEntries(values) };
  }
  if (profile.glassesParameter) next.glasses = patch.glasses === true;
  if (profile.layers) {
    next.layerShapes = layerTuning(patch.layerShapes, profile.layers.filter(layer => layer.shape).map(layer => layer.id), defaultLive2DLayerShape);
    next.layerSway = layerTuning(patch.layerSway, profile.layers.flatMap(layer => layer.sway ?? []), defaultLive2DLayerSway,
      (id, key) => key !== 'response' || !!profile.swayResponse?.includes(id));
  }
  if (profile.idle) {
    next.motionTracks = layerTuning(patch.motionTracks, live2DTunableTracks(profile), defaultLive2DTrackTuning);
  }
  const mouth = object(patch.mouth);
  next.mouth = {};
  for (const key of ['open', 'form', 'wide', 'round'] as const) {
    const id = mouth[key];
    if (typeof id === 'string' && id.trim()) next.mouth[key] = id.trim().slice(0, 128);
  }
  next.cues = {};
  const cues = object(patch.cues);
  for (const state of ['off', 'listening', 'recognizing', 'thinking', 'speaking', 'paused', 'waiting', 'silent', 'error', 'tap'] as const) {
    const cue = object(cues[state]);
    const motion = object(cue.motion);
    const expression = typeof cue.expression === 'string' && profile.expressions.includes(cue.expression) ? cue.expression : undefined;
    const selectedMotion = profile.motions.find(item => item.group === motion.group && item.index === motion.index && item !== profile.idle?.motion);
    if (expression || selectedMotion) next.cues[state] = { expression, motion: selectedMotion };
  }
  return next;
}

async function inspect(definition: Definition, source: Live2DProfile['source']): Promise<Bundle> {
  const file = await realpath(definition.file);
  const root = path.dirname(file);
  const entry = reference(path.basename(file), /\.model3\.json$/i);
  if ((await stat(file)).size > MiB) throw new Error('模型清单过大。');
  const manifest = object(await readJson(file));
  const refs = object(manifest.FileReferences);
  if (manifest.Version !== 3 || !Array.isArray(refs.Textures) || !refs.Textures.length || refs.Textures.length > 32)
    throw new Error('请选择带贴图的 Cubism .model3.json。');
  const warnings: string[] = [];
  const names = new Set<string>();
  const add = (raw: unknown, type: RegExp) => { const name = reference(raw, type); names.add(name); return name; };
  refs.Moc = add(refs.Moc, /\.moc3$/i);
  refs.Textures = refs.Textures.map(texture => add(texture, /\.(png|jpe?g|webp)$/i));
  for (const [field, suffix] of [
    ['Physics', /\.physics3\.json$/i], ['Pose', /\.pose3\.json$/i], ['UserData', /\.userdata3\.json$/i],
  ] as const) if (refs[field] !== undefined) refs[field] = add(refs[field], suffix);
  const expressions: string[] = [];
  if (Array.isArray(refs.Expressions)) for (const expression of refs.Expressions) {
    if (!expression || typeof expression.Name !== 'string' || expressions.includes(expression.Name)) throw new Error('模型表情名称无效或重复。');
    expression.File = add(expression.File, /\.exp3\.json$/i);
    expressions.push(expression.Name);
  }
  const motions: Live2DMotion[] = [];
  const motionFiles = new Map<Live2DMotion, string>();
  for (const [group, values] of Object.entries(object(refs.Motions))) {
    if (!Array.isArray(values)) throw new Error('模型动作组无效。');
    values.forEach((value, index) => {
      value.File = add(value.File, /\.motion3\.json$/i);
      delete value.Sound;
      const motion = { group, index };
      motions.push(motion);
      motionFiles.set(motion, value.File);
    });
  }
  if (names.size > 512) throw new Error('模型引用的文件过多。');
  const references = new Map(await Promise.all([...names].map(async name =>
    [name, await modelResource(root, name, 64 * MiB)] as const)));
  const moc = await open(references.get(refs.Moc as string)!, 'r');
  try {
    const head = Buffer.alloc(4);
    await moc.read(head);
    if (head.toString('ascii') !== 'MOC3') throw new Error('MOC3 文件无效。');
  } finally { await moc.close(); }
  const lipSync = Array.isArray(manifest.Groups) ? manifest.Groups.flatMap((group: unknown) => {
    const { Name, Ids } = object(group);
    return Name === 'LipSync' ? ids(Ids) : [];
  }) : [];
  let display: Live2DProfile['display'];
  if (refs.DisplayInfo !== undefined) {
    try {
      const name = reference(refs.DisplayInfo, /\.cdi3\.json$/i);
      const target = await modelResource(root, name, MiB);
      display = displayInfo(await readJson(target));
      refs.DisplayInfo = name;
      references.set(name, target);
    } catch {
      warnings.push('显示信息不可用，使用模型中的部件与参数 ID。');
      delete refs.DisplayInfo;
    }
  }
  let metadata;
  try {
    const name = reference(definition.layerFile ?? entry.replace(/\.model3\.json$/i, '.layers.json'), /\.layers\.json$/i);
    metadata = layerRig(await readJson(await modelResource(root, name, MiB)));
  } catch (error) {
    if (definition.layerFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('图层调校清单不可用。');
  }
  const findMotion = (candidate?: Live2DMotion) => motions.find(({ group, index }) => group === candidate?.group && index === candidate.index);
  const declaredIdle = metadata?.idle ?? idleRig(definition.idle);
  let idle: Live2DIdleRig | undefined;
  if (declaredIdle) {
    try {
      const motion = findMotion(declaredIdle.motion);
      if (!motion) throw new Error('待机动作不可用。');
      const availableTracks = idleTrackIds(await readJson(references.get(motionFiles.get(motion)!)!));
      const configured = new Set(Object.values(declaredIdle.tracks).flat());
      const tracks = Object.fromEntries(Object.entries(declaredIdle.tracks).flatMap(([id, ids]) => {
        const channels = ids.filter(value => availableTracks.has(value));
        return channels.length ? [[id, channels] as const] : [];
      }));
      const base = [...(tracks.base ?? []), ...[...availableTracks].filter(id => !configured.has(id))];
      if (base.length) tracks.base = base;
      idle = { ...declaredIdle, motion, tracks };
    } catch {
      warnings.push('调校待机需要模型清单中有效的纯参数动作。');
    }
  }
  const physicsFile = typeof refs.Physics === 'string' ? references.get(refs.Physics) : undefined;
  const { outputs, response } = physicsOutputs(physicsFile && (metadata?.layers?.some(layer => layer.sway?.length) || idle)
    ? await readJson(physicsFile).catch(() => undefined) : undefined);
  if (idle) idle.physics = Object.fromEntries(Object.entries(idle.physics).flatMap(([group, ids]) => {
    const channels = ids.filter(id => outputs.has(id));
    return channels.length ? [[group, channels] as const] : [];
  }));
  const blink = findMotion(metadata?.blink) ?? motions.find(item => item.group.toLowerCase() === 'blink');
  const url = `deskai://app/live2d/${definition.id}/${encodeURIComponent(entry)}`;
  const profile: Live2DProfile = { id: definition.id, name: definition.name, url, source, textures: refs.Textures as string[], lipSync, expressions, motions,
    physics: !!refs.Physics, display, motionGroups: metadata?.motionGroups, idle, blink, swayResponse: response,
    layers: metadata?.layers?.map(layer => ({ ...layer, sway: layer.sway?.filter(id => outputs.has(id)) })),
    glassesParameter: metadata?.glassesParameter ?? definition.glassesParameter,
    warnings: warnings.length ? warnings : undefined, style: defaultLive2DStyle };
  profile.style = tuning(profile, definition.style);
  return { file, root, definition, profile, references, entry, manifest: JSON.stringify(manifest) };
}

/** Owns only model references and appearance settings. Imported assets stay in their original folders. */
export class Live2DLibrary {
  private readonly bundles = new Map<string, Bundle>();
  private saved: Saved = { models: [], bindings: {}, styles: {} };
  private saving: Promise<unknown> = Promise.resolve();
  private core?: Buffer;
  private readonly issues: string[] = [];
  private readonly storage: string;

  private constructor(storage: string) { this.storage = storage; }

  static async open(root: string, userData: string): Promise<Live2DLibrary> {
    const config = JSON.parse(await readFile(path.join(root, 'config/live2d-models.json'), 'utf8')) as Config;
    const assetRoot = path.join(root, '.cache/live2d');
    const library = new Live2DLibrary(path.join(userData, 'live2d-library.json'));
    const core = await readFile(path.join(assetRoot, coreName)).catch(() => undefined);
    if (core && createHash('sha256').update(core).digest('hex') === config.core.sha256) library.core = core;
    if (!library.core) library.issues.push('Cubism Core 未准备，请运行 npm run desktop:prepare-live2d。');
    try {
      const saved = object(JSON.parse(await readFile(library.storage, 'utf8')));
      if (!Array.isArray(saved.models)) throw new Error('INVALID_LIVE2D_LIBRARY');
      const models = saved.models.filter(model => typeof model?.id === 'string' && typeof model.name === 'string' && typeof model.file === 'string')
        .map(({ id, name, file }) => ({ id, name, file }));
      library.saved = { models, bindings: object(saved.bindings) as Saved['bindings'],
        styles: object(saved.styles) as Saved['styles'] };
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') library.issues.push('无法读取 Live2D 外观设置。');
    }
    const local = Array.isArray(library.saved.models) ? library.saved.models : [];
    const bundled = config.bundled.map(model => ({ ...model, file: path.join(root, model.file) }));
    const samples = config.samples.models.map(model => ({ ...model, file: path.join(assetRoot, model.file) }));
    for (const [models, source] of [[bundled, 'bundled'], [samples, 'sample'], [local, 'local']] as const) {
      for (const model of models) {
        try {
          if (!/^[\w-]+$/u.test(model.id) || library.bundles.has(model.id)) throw new Error('模型标识无效。');
          const shared = source === 'local' ? [...library.bundles.values()].find(bundle => !path.relative(bundle.file, model.file)) : undefined;
          const definition = shared ? { ...shared.definition, ...model } : model;
          const bundle = await inspect(definition, source);
          const savedStyle = library.saved.styles?.[model.id];
          if (savedStyle) bundle.profile.style = tuning(bundle.profile, savedStyle);
          library.bundles.set(model.id, bundle);
        } catch {
          if (source !== 'sample') library.issues.push(`${model.name}的模型文件不可用。`);
        }
      }
    }
    return library;
  }

  catalog(): Live2DCatalog {
    return { coreReady: !!this.core, models: [...this.bundles.values()].map(bundle => bundle.profile),
      bindings: this.saved.bindings, issues: this.issues.slice() };
  }

  resolve(personaId: string): Live2DProfile | undefined {
    const id = this.saved.bindings[personaId];
    return this.core && id ? this.bundles.get(id)?.profile : undefined;
  }

  async import(file: string): Promise<{ catalog: Live2DCatalog; id: string }> {
    const bundle = await inspect({ id: randomUUID(), name: path.basename(file).replace(/\.model3\.json$/i, ''), file }, 'local');
    return this.transact(async () => {
      const existing = [...this.bundles.values()].find(value => !path.relative(value.file, bundle.file));
      if (existing) return { catalog: this.catalog(), id: existing.profile.id };
      await this.save({ ...this.saved, models: [...this.saved.models,
        { id: bundle.profile.id, name: bundle.profile.name, file: bundle.file }] });
      this.bundles.set(bundle.profile.id, bundle);
      return { catalog: this.catalog(), id: bundle.profile.id };
    });
  }

  apply(input: Live2DApply): Promise<Live2DCatalog> {
    return this.transact(async () => {
      if (typeof input?.personaId !== 'string' || !/^[\w-]{1,128}$/u.test(input.personaId)) throw new Error('角色标识无效。');
      const bundle = input.modelId === null ? undefined : this.bundles.get(input.modelId);
      if (!bundle && input.modelId !== null) throw new Error('模型不可用。');
      const next = { ...this.saved, bindings: { ...this.saved.bindings, [input.personaId]: input.modelId } };
      const style = bundle && input.style ? tuning(bundle.profile, input.style) : undefined;
      if (bundle && style) next.styles = { ...next.styles, [bundle.profile.id]: style };
      await this.save(next);
      if (bundle && style) bundle.profile = { ...bundle.profile, style };
      return this.catalog();
    });
  }

  async asset(relative: string): Promise<{ data: Uint8Array; type: string } | undefined> {
    if (relative === coreName && this.core) return { data: new Uint8Array(this.core), type: 'text/javascript' };
    const slash = relative.indexOf('/');
    if (slash < 0) return;
    const bundle = this.bundles.get(relative.slice(0, slash));
    const name = relative.slice(slash + 1);
    if (!bundle) return;
    if (name === bundle.entry) return { data: new TextEncoder().encode(bundle.manifest), type: 'application/json' };
    const file = bundle.references.get(name);
    if (!file) return;
    const target = await realpath(file);
    if (!inside(bundle.root, target)) return;
    const ext = path.extname(target).toLowerCase();
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.json': 'application/json' };
    return { data: new Uint8Array(await readFile(target)), type: mime[ext] ?? 'application/octet-stream' };
  }

  private transact<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.saving.then(operation, operation);
    this.saving = result;
    return result;
  }

  private async save(next: Saved): Promise<void> {
    await mkdir(path.dirname(this.storage), { recursive: true });
    const temporary = `${this.storage}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2));
    await rename(temporary, this.storage);
    this.saved = next;
  }
}
