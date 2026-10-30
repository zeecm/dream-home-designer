import {
  placeUnderlay,
  rotateUnderlay,
  setUnderlay,
  setUnderlayOpacity,
  underlayToWorld,
} from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import {
  type AssetState,
  bundledAsset,
  getAsset,
  hashBlob,
  hashOfKey,
  keyOfHash,
  normalizeForServer,
  prepareUpload,
  putAsset,
  useAsset,
} from '../assets';
import { useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { icons } from './icons';

/**
 * Stores an uploaded plan in this browser, puts it under the plan centred in view, and
 * copies it to the server in the background.
 */
export async function uploadPlanImage(file: File): Promise<void> {
  const projectId = useStore.getState().editor.doc.id;
  const { width, height, blob } = await prepareUpload(file);
  const key = keyOfHash(await hashBlob(blob));
  // A PDF can take a moment to render; don't put it on a different plan opened meanwhile.
  if (useStore.getState().editor.doc.id !== projectId) return;
  await putAsset(key, blob);
  const view = useEditor.getState().view;
  const centre = view ? { x: view.cx, y: view.cy } : { x: 0, y: 0 };
  useStore.getState().dispatch(setUnderlay(placeUnderlay(key, { width, height }, centre)));
  // Straight into calibration: the image's scale is only a guess until then.
  useEditor.getState().setTool('calibrate');
  void syncPlanImage();
}

/** Per project: the image key the server is known to hold. */
const synced = new Map<string, string>();
/** Per project: the sync queue, so uploads never overlap and the last image wins. */
const queues = new Map<string, Promise<void>>();
/** `project|key` pairs the server can't take (format or size), noticed once a session. */
const refused = new Set<string>();

/** Server statuses that won't change on a retry: too large, or not an image it accepts. */
const permanent = (e: unknown) => e instanceof Error && /^(413|415) /.test(e.message);

/** Runs `job` after any sync or delete already queued for the project. */
function enqueue(projectId: string, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(projectId) ?? Promise.resolve()).then(job).catch(() => {});
  queues.set(projectId, next);
  return next;
}

/**
 * Deletes the server's copy of the open project's plan image (it was removed). Queued like
 * uploads, so an Undo straight after uploads it again only once the delete is done.
 */
export function deleteServerImage(): Promise<void> {
  const { backend, editor } = useStore.getState();
  const projectId = editor.doc.id;
  return enqueue(projectId, async () => {
    synced.delete(projectId);
    await backend?.deleteImage?.(projectId);
  });
}

/**
 * Makes sure the server has the open project's plan image, uploading it from this browser
 * if not. Images the server can't take as they are (older uploads in other formats, very
 * large photos or PDF renders) are re-encoded first and re-keyed by their new hash, with
 * the scale adjusted so calibration holds; that re-key is not an undo step. Runs one at a
 * time per project, and checks again if the image changed meanwhile.
 */
export function syncPlanImage(): Promise<void> {
  const id = useStore.getState().editor.doc.id;
  return enqueue(id, () => syncOnce(id));
}

async function syncOnce(projectId: string): Promise<void> {
  const { backend, editor, sync } = useStore.getState();
  const key = editor.doc.underlay?.assetKey;
  if (editor.doc.id !== projectId || !key || !backend?.putImage || !backend.hasImage) return;
  // Only for a plan that is open for editing: a re-key couldn't be recorded otherwise.
  if (!['saved', 'dirty', 'saving'].includes(sync.kind)) return;
  const tag = `${projectId}|${key}`;
  if (synced.get(projectId) === key || refused.has(tag)) return;
  try {
    const local = (await getAsset(key)) ?? (await bundledAsset(key));
    if (!local) return; // not in this browser: nothing to upload from here
    const hash = hashOfKey(key);
    if (hash && (await backend.hasImage(projectId, hash))) {
      synced.set(projectId, key);
      return;
    }
    const { blob, factor } = await normalizeForServer(local);
    const sentHash = blob === local && hash ? hash : await hashBlob(blob);
    await backend.putImage(projectId, blob);
    let held = key;
    if (sentHash !== hash) {
      held = keyOfHash(sentHash);
      await putAsset(held, blob);
      const now = useStore.getState().editor.doc;
      if (now.id === projectId && now.underlay?.assetKey === key) {
        const underlay = { ...now.underlay, assetKey: held, scale: now.underlay.scale / factor };
        useStore.getState().dispatch(setUnderlay(underlay), { record: false });
      }
    }
    synced.set(projectId, held);
  } catch (e) {
    if (useStore.getState().editor.doc.id !== projectId) return;
    if (permanent(e)) refused.add(tag);
    useStore.setState({
      notice: permanent(e)
        ? 'The server couldn’t take this plan image, so it shows only in this browser. Try a smaller JPG or PNG.'
        : 'The plan image couldn’t be copied to the server yet, so it shows only in this browser for now.',
    });
    return;
  }
  // Replaced or undone while this ran: catch up.
  const now = useStore.getState().editor.doc;
  if (now.id === projectId && now.underlay && now.underlay.assetKey !== synced.get(projectId)) {
    void syncPlanImage();
  }
}

/** The open project's plan image, fetched from the server if this browser lacks it. */
export function usePlanImage(): AssetState {
  const project = useProject();
  const key = project.underlay?.assetKey;
  const backend = useStore((s) => s.backend);
  const id = project.id;
  useEffect(() => {
    if (key && backend) void syncPlanImage();
  }, [key, backend]);
  const getImage = backend?.getImage;
  return useAsset(key, getImage ? (hash) => getImage(id, hash) : undefined);
}

/** Bundled plans for trying the tracing flow without a plan of your own. */
const SAMPLES = {
  drawn: { path: '/samples/sample-4room-plan.png', type: 'image/png' },
  hdb: { path: '/samples/hdb-3room-type4.pdf', type: 'application/pdf' },
} as const;

export async function loadSamplePlanImage(which: keyof typeof SAMPLES = 'drawn'): Promise<void> {
  const { path, type } = SAMPLES[which];
  const res = await fetch(path);
  if (!res.ok) throw new Error('The sample plan could not be loaded.');
  const blob = await res.blob();
  await uploadPlanImage(new File([blob], path.split('/').pop() ?? 'sample', { type }));
}

export function useUploadPicker() {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/*,application/pdf,.pdf"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        setBusy(true);
        setError(null);
        uploadPlanImage(f)
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    />
  );
  const sample = (which: keyof typeof SAMPLES = 'drawn') => {
    setBusy(true);
    setError(null);
    loadSamplePlanImage(which)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return { picker, open: () => input.current?.click(), sample, error, busy };
}

/** Whole degrees, or two decimals once quarter-degree nudges are in play. */
const deg = (r: number) => {
  const d = Math.round(((r * 180) / Math.PI) * 100) / 100;
  return Number.isInteger(d) ? d.toFixed(0) : d.toFixed(2);
};

export function PlanImagePanel() {
  const underlay = useProject().underlay;
  const asset = usePlanImage();
  const dispatch = useStore((s) => s.dispatch);
  const setTool = useEditor((s) => s.setTool);
  const { picker, open, sample, error, busy } = useUploadPicker();

  if (!underlay) {
    return (
      <section className="tool-options" aria-labelledby="img-h">
        <h3 id="img-h" className="panel-heading">
          Plan image
        </h3>
        <button type="button" className="btn btn-block" onClick={open} disabled={busy}>
          {icons.image}
          {busy ? 'Reading…' : 'Upload floor plan'}
        </button>
        <p className="field-hint">JPG, PNG or the first page of a PDF, up to 25 MB.</p>
        <p className="field-hint">
          No plan to hand? Try{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => sample('drawn')}
            disabled={busy}
          >
            a simple sample
          </button>{' '}
          or{' '}
          <button type="button" className="link-btn" onClick={() => sample('hdb')} disabled={busy}>
            a real HDB 3-room plan (PDF)
          </button>
          .
        </p>
        {error && <p className="field-hint error-text">{error}</p>}
        {picker}
      </section>
    );
  }

  const pivot = () => {
    if (asset.status !== 'ready') return underlay.origin;
    return underlayToWorld(underlay, { x: asset.width / 2, y: asset.height / 2 });
  };
  const rotate = (by: number) => dispatch(rotateUnderlay(underlay.rotation + by, pivot()));
  const mPerPx = underlay.scale;

  return (
    <section className="tool-options" aria-labelledby="img-h">
      <h3 id="img-h" className="panel-heading">
        Plan image
      </h3>
      {asset.status === 'missing' && (
        <p className="field-hint error-text">
          This image is stored only in the browser it was uploaded from. Upload it again to trace
          here.
        </p>
      )}
      <label className="slider">
        <span>Opacity</span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={underlay.opacity}
          onChange={(e) =>
            dispatch(setUnderlayOpacity(Number(e.target.value)), {
              coalesceKey: 'underlay-opacity',
            })
          }
        />
      </label>
      <div className="slider">
        <span>Rotation</span>
        <div className="rotation-row">
          <button
            type="button"
            className="icon-btn"
            onClick={() => rotate(-Math.PI / 2)}
            aria-label="Rotate 90° anticlockwise"
            title="Rotate 90° anticlockwise"
          >
            ⟲
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => rotate(-Math.PI / 720)}
            aria-label="Nudge anticlockwise"
            title="Nudge ¼° anticlockwise"
          >
            {icons.minus}
          </button>
          <span className="num rotation-value">{deg(underlay.rotation)}°</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => rotate(Math.PI / 720)}
            aria-label="Nudge clockwise"
            title="Nudge ¼° clockwise"
          >
            {icons.plus}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => rotate(Math.PI / 2)}
            aria-label="Rotate 90° clockwise"
            title="Rotate 90° clockwise"
          >
            ⟳
          </button>
        </div>
      </div>
      <button type="button" className="btn btn-block" onClick={() => setTool('calibrate')}>
        {icons.calibrate}
        Set scale
      </button>
      <p className="field-hint num">1 m on the plan = {Math.round(1 / mPerPx)} image px</p>
      <div className="button-row">
        <button type="button" className="btn btn-small" onClick={open} disabled={busy}>
          Replace
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          onClick={() => {
            dispatch(setUnderlay(null));
            // The server's copy goes too (undo uploads it again from this browser), but only
            // if the plan really lost it: nothing changes while the plan can't be edited.
            if (!useStore.getState().editor.doc.underlay) void deleteServerImage();
          }}
        >
          Remove
        </button>
      </div>
      {error && <p className="field-hint error-text">{error}</p>}
      {picker}
    </section>
  );
}
