import { addModel, customModelFile, newId } from '@dhd/core';
import { useEffect } from 'react';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getAsset, hashBlob, hashOfKey, putAsset } from './assets';
import { NotFoundError } from './backend';
import { useEditor } from './editor';
import { MAX_MODEL_BYTES, isGlb, modelSize, nameOfFile } from './modelFiles';
import { useStore } from './store';

/**
 * Furniture models people upload (binary glTF). A model is kept in this browser by its
 * content key (`sha256:<hex>`, as plan images are), added to the project's `models`, and
 * copied to the server in the background, from where another browser fetches it.
 */

let draco: DRACOLoader | undefined;
/**
 * Readies a loader for models made anywhere: meshopt (as the catalogue's) and Draco
 * compression (common from Blender), its decoder fetched from /draco/ when first needed.
 */
export function configureLoader(loader: GLTFLoader) {
  draco ??= new DRACOLoader().setDecoderPath('/draco/');
  loader.setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(draco);
}

async function measure(buf: ArrayBuffer) {
  const loader = new GLTFLoader();
  configureLoader(loader);
  const gltf = await loader.parseAsync(buf, '');
  const box = new THREE.Box3().setFromObject(gltf.scene);
  if (box.isEmpty()) throw new Error('empty');
  return modelSize(box.getSize(new THREE.Vector3()));
}

/**
 * Adds a model file to the open project and arms the Furniture tool with it. Returns
 * what went wrong, in words, or null.
 */
export async function addModelFile(file: File): Promise<string | null> {
  if (file.size > MAX_MODEL_BYTES) return 'That model is larger than 20 MB.';
  const buf = await file.arrayBuffer();
  if (!isGlb(buf)) {
    return /\.gltf$/i.test(file.name)
      ? 'Use the single-file .glb form of the model (most tools export it beside .gltf).'
      : 'That isn’t a .glb model file.';
  }
  let size: { w: number; d: number; h: number };
  try {
    size = await measure(buf);
  } catch {
    return 'That model couldn’t be read, or has nothing in it.';
  }
  const projectId = useStore.getState().editor.doc.id;
  const blob = new Blob([buf], { type: 'model/gltf-binary' });
  const hash = await hashBlob(blob);
  await putAsset(customModelFile(hash), blob);
  if (useStore.getState().editor.doc.id !== projectId) return null;
  const existing = Object.values(useStore.getState().editor.doc.models ?? {}).find(
    (m) => m.hash === hash,
  );
  const id = existing?.id ?? newId('mdl');
  if (!existing) {
    useStore
      .getState()
      .dispatch(addModel({ id, name: nameOfFile(file.name), hash, category: 'Decor', size }));
  }
  const editor = useEditor.getState();
  editor.setFurnitureKind(id);
  editor.setTool('furniture');
  void syncModels();
  return null;
}

/** Per project: the model hashes the server is known to hold. */
const synced = new Map<string, Set<string>>();
/** `project|hash` pairs the server refused (too large, not a model, too many). */
const refused = new Set<string>();
const queues = new Map<string, Promise<void>>();

/**
 * Makes sure the server has the open project's models, uploading those this browser holds.
 * One run at a time per project.
 */
export function syncModels(): Promise<void> {
  const id = useStore.getState().editor.doc.id;
  const next = (queues.get(id) ?? Promise.resolve()).then(() => syncOnce(id)).catch(() => {});
  queues.set(id, next);
  return next;
}

async function syncOnce(projectId: string) {
  const { backend, editor, sync, role } = useStore.getState();
  if (editor.doc.id !== projectId || !backend?.putModel || !backend.listModels) return;
  // Only for a plan open for editing: a view-only link can't store anything.
  if (role === 'viewer' || !['saved', 'dirty', 'saving'].includes(sync.kind)) return;
  const held = synced.get(projectId) ?? new Set<string>();
  synced.set(projectId, held);
  const todo = Object.values(editor.doc.models ?? {}).filter(
    (m) => !held.has(m.hash) && !refused.has(`${projectId}|${m.hash}`),
  );
  if (todo.length === 0) return;
  // Ask once what the server has, so a model is never sent twice.
  for (const h of await backend.listModels(projectId)) held.add(h);
  const missing: string[] = [];
  for (const m of todo) {
    if (held.has(m.hash)) continue;
    const blob = await getAsset(customModelFile(m.hash)).catch(() => undefined);
    if (!blob) {
      missing.push(m.name);
      continue;
    }
    try {
      await backend.putModel(projectId, blob);
      held.add(m.hash);
    } catch (e) {
      if (useStore.getState().editor.doc.id !== projectId) return;
      const permanent = e instanceof Error && /^(413|415|422) /.test(e.message);
      if (permanent) refused.add(`${projectId}|${m.hash}`);
      useStore.setState({
        notice: permanent
          ? `The server couldn’t take the model “${m.name}”, so it shows only in this browser.`
          : 'A furniture model couldn’t be copied to the server yet, so it shows only in this browser for now.',
      });
      return;
    }
  }
  // Named by the plan, but on neither this device nor the server (an imported plan, say).
  if (missing.length && useStore.getState().editor.doc.id === projectId) {
    for (const m of todo) if (missing.includes(m.name)) refused.add(`${projectId}|${m.hash}`);
    useStore.setState({
      notice: `The model ${missing.map((n) => `“${n}”`).join(', ')} isn’t on this device or the server, so it shows as a box. Upload it again to see it.`,
    });
  }
}

/**
 * An uploaded model's bytes, for the 3D view: from this browser, or else from the server
 * (then kept here, if this browser can keep things).
 */
export async function fetchUploaded(key: string): Promise<ArrayBuffer> {
  const local = await getAsset(key).catch(() => undefined);
  if (local) return local.arrayBuffer();
  const hash = hashOfKey(key);
  const { backend, editor } = useStore.getState();
  if (!hash || !backend?.getModel) throw new NotFoundError('model not in this browser');
  const blob = await backend.getModel(editor.doc.id, hash);
  await putAsset(key, blob).catch(() => {});
  return blob.arrayBuffer();
}

/** Keeps the server's copies of the open project's models up to date (call once, in App). */
export function useModelSync() {
  const id = useStore((s) => s.editor.doc.id);
  const models = useStore((s) => s.editor.doc.models);
  const backend = useStore((s) => s.backend);
  const sync = useStore((s) => s.sync.kind);
  const ready = sync === 'saved' || sync === 'dirty' || sync === 'saving';
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-checks on these changes
  useEffect(() => {
    if (ready && models && backend?.putModel) void syncModels();
  }, [id, models, backend, ready]);
}
