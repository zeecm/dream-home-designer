import { usageTotals } from '@dhd/core';
import { useEffect, useId, useRef, useState } from 'react';
import { useEditor } from '../../editor';
import { useStore } from '../../store';
import { Segmented } from '../../ui/fields';
import { AiSettingsDialog } from '../AiSettingsDialog';
import { LayoutsDialog } from '../LayoutsDialog';
import { aiSettings } from '../credentials';
import { BriefDialog } from './BriefDialog';
import { usd } from './spend';
import { acceptedNow, endPreview, openPanel, useDesigner } from './state';

/**
 * Where the designer starts (Plan details ▸ Renovation): Design my flat (or the versions
 * there are), and Suggest layouts. Not on a view-only link.
 */
export function DesignerEntry() {
  const viewer = useStore((s) => s.role === 'viewer');
  const hasRooms = useStore((s) => Object.keys(s.editor.doc.levels[0]?.rooms ?? {}).length > 0);
  const designs = useDesigner((s) => s.designs.length);
  const [layouts, setLayouts] = useState(false);
  const hint = useId();
  if (viewer) return null;
  const design = () => {
    if (designs) openPanel();
    else openBrief();
  };
  return (
    <div className="designer-entry">
      <button
        type="button"
        className="btn btn-block"
        disabled={!hasRooms}
        aria-describedby={!hasRooms ? hint : undefined}
        onClick={design}
        data-designer-open=""
      >
        {designs ? `Designs (${designs})` : 'Design my flat with AI'}
      </button>
      {!hasRooms && (
        <span id={hint} className="field-hint">
          Draw rooms first.
        </span>
      )}
      <button type="button" className="btn btn-block" onClick={() => setLayouts(true)}>
        Suggest layouts with AI
      </button>
      <p className="field-hint">
        Layouts: walls only, a few cents. Design: walls, furniture, paint and cost, about
        US$0.30–1.50 (the cost is shown before it runs).
      </p>
      {layouts && (
        <LayoutsDialog
          onClose={() => setLayouts(false)}
          {...(hasRooms ? { onDesign: openBrief } : {})}
        />
      )}
    </div>
  );
}

/** Opens the brief (AI settings first, if there's no key: saving it goes on to the brief). */
export function openBrief() {
  useDesigner.setState({ briefOpen: true });
}

/** The brief and the key, mounted once for the app. */
export function DesignerDialogs() {
  const leaving = useDesigner((s) => s.leaving);
  return (
    <>
      <BriefDialogs />
      {leaving && <LeaveDialog answer={leaving} />}
    </>
  );
}

/** Another plan is opening while a design runs: stop it (keeping what's done), or stay. */
function LeaveDialog({ answer }: { answer: (go: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    stay.current?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog dialog-confirm"
      aria-labelledby="leave-h"
      onCancel={(e) => {
        e.preventDefault();
        answer(false);
      }}
    >
      <div className="dialog-head">
        <h2 id="leave-h">Stop designing and open the other plan?</h2>
      </div>
      <div className="confirm-body">
        <p>The steps already finished are kept in this plan’s designs.</p>
      </div>
      <footer className="dialog-foot">
        <div className="button-row">
          <button type="button" className="btn" onClick={() => answer(true)}>
            Stop and open
          </button>
          <button
            ref={stay}
            type="button"
            className="btn btn-primary"
            onClick={() => answer(false)}
          >
            Keep designing
          </button>
        </div>
      </footer>
    </dialog>
  );
}

function BriefDialogs() {
  const open = useDesigner((s) => s.briefOpen);
  const [needKey, setNeedKey] = useState(false);
  useEffect(() => {
    if (open && !aiSettings()) setNeedKey(true);
  }, [open]);
  if (!open) return null;
  if (needKey) {
    return (
      <AiSettingsDialog
        onClose={() => {
          setNeedKey(false);
          if (!aiSettings()) useDesigner.setState({ briefOpen: false });
        }}
      />
    );
  }
  return <BriefDialog onClose={() => useDesigner.setState({ briefOpen: false })} />;
}

/**
 * Over the stage: while a version is previewed, which one and how to leave it (Before | V2,
 * Accept…, Back to my plan); while a run goes on with the panel closed, how far it is.
 */
export function DesignerBar() {
  const preview = useEditor((s) => s.preview);
  const walking = useEditor((s) => !!s.walking);
  const run = useDesigner((s) => s.run);
  const panel = useDesigner((s) => s.panel);
  const selected = useDesigner((s) => s.selected);
  // A version in the renovation is shown as the plan has it (with any changes made by hand).
  const shownDesign = useDesigner((s) => s.designs.find((x) => x.id === s.selected));
  const after = useStore((s) => s.editor.doc.renovation?.levels[0]);
  const inPlan = !!shownDesign && acceptedNow(shownDesign, after);
  // The bar coming or going changes the plan's height: fit the plan to what's left, with a
  // margin, so nothing of it is cut under the bar or the designer's sheet.
  const barShown = !!preview || (!!run && !panel);
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the bar comes or goes
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => useEditor.getState().requestFit(64));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [barShown]);
  // Esc leaves the preview (when nothing else wants it).
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]'))
        return;
      if (useDesigner.getState().run || useEditor.getState().selection) return;
      e.preventDefault();
      endPreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);
  // Walking hides the bar: a small reminder in its place.
  if (preview && walking) {
    return (
      <output className="designer-walk-pill">
        {preview.side === 'before'
          ? 'Showing the flat as it is'
          : `Previewing ${preview.label}, not your plan`}
      </output>
    );
  }
  if (preview) {
    return (
      <div className="reno-bar designer-bar">
        <Segmented
          label="Show"
          value={preview.side}
          onChange={(side) => useEditor.getState().setPreview({ ...preview, side })}
          options={[
            { value: 'before', label: 'Before', title: 'The flat as it is' },
            { value: 'version', label: preview.label, title: `Design ${preview.label}` },
          ]}
        />
        <span className="designer-bar-text">
          {inPlan
            ? `${preview.label} is in your renovation, shown as your plan has it`
            : `Previewing ${preview.label}, not in your plan yet`}
        </span>
        <span className="button-row">
          {!run && selected && (
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => useDesigner.setState({ accepting: selected })}
            >
              Accept…
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={endPreview}>
            Back to my plan
          </button>
        </span>
      </div>
    );
  }
  if (run && !panel) {
    const done = run.state.steps.filter((s) => s.status === 'done').length;
    const n = run.state.steps.length;
    return (
      <div className="reno-bar designer-bar">
        <button type="button" className="link-btn" onClick={openPanel}>
          Designing {Math.min(done + 1, Math.max(n, 1))} of {Math.max(n, 1)} ·{' '}
          {usd(usageTotals(run.state.usage).usd ?? 0)}
        </button>
      </div>
    );
  }
  return null;
}
