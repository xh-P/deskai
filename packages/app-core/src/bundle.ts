import path from 'node:path';
import type { ArtifactRegistry } from './artifacts.ts';
import { parseManifest, type Manifest } from './auip-contract.ts';

const manifestName = 'auip.manifest.json';
const bundleLimit = 8 * 1024 * 1024;
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'
};

export const bundlePath = (value: string) => value.replace(/\\/g, '/');
export const urlPath = (value: string) => value.split('/').map(encodeURIComponent).join('/');
export type BundleFile = { bytes: Buffer; mime: string };
export interface VerifiedBundle { entry: string; artifactId: string; manifest: Manifest; files: Map<string, BundleFile> }

function localResources(html: string): string[] {
  const sources: string[] = [];
  for (const tag of html.matchAll(/<(script|link|img)\b([^<>]*)>/gi)) {
    const attributes = new Map([...tag[2].matchAll(/([^\s=/'"]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(match => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]]));
    const reference = tag[1].toLowerCase() === 'link' ? attributes.get('rel') === 'stylesheet' && attributes.get('href') : attributes.get('src');
    if (reference && !reference.startsWith('data:')) sources.push(reference);
  }
  return sources;
}

function resourcePath(entry: string, reference: string): string {
  const source = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  if (!source || source.startsWith('/') || /[:\\\0]/.test(source)) throw new Error('app_resource_outside_bundle');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), source));
  if (resolved === '..' || resolved.startsWith('../')) throw new Error('app_resource_outside_bundle');
  return resolved;
}

/** Freeze the verified entry, sidecar and referenced assets for one application launch. */
export async function readBundle(registry: ArtifactRegistry, artifactId: string): Promise<VerifiedBundle> {
  const { artifact, bytes } = await registry.readVerified(artifactId);
  const entry = bundlePath(artifact.relativePath);
  if (path.posix.extname(entry).toLowerCase() !== '.html' || bytes.length > bundleLimit) throw new Error('app_entry_invalid');
  const owned = new Map(registry.listArtifacts().filter(file => file.taskId === artifact.taskId && file.workDir === artifact.workDir)
    .map(file => [bundlePath(file.relativePath), file.id]));
  const sidecar = path.posix.join(path.posix.dirname(entry), manifestName);
  const files = new Map<string, BundleFile>([[entry, { bytes, mime: contentTypes['.html'] }]]);
  let size = bytes.length;
  for (const member of new Set([sidecar, ...localResources(bytes.toString('utf8')).map(ref => resourcePath(entry, ref))])) {
    const id = owned.get(member);
    const mime = contentTypes[path.posix.extname(member).toLowerCase()];
    if (!id || !mime || mime.startsWith('text/html')) throw new Error(`app_bundle_member_unverified: ${member}`);
    const file = await registry.readVerified(id);
    size += file.bytes.length;
    if (size > bundleLimit) throw new Error('app_bundle_too_large');
    files.set(member, { bytes: file.bytes, mime });
  }
  const manifest = parseManifest(JSON.parse(files.get(sidecar)!.bytes.toString('utf8')));
  return { entry, artifactId, manifest, files };
}
