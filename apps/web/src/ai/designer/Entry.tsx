import { usageTotals } from '@dhd/core';
import { useEffect, useId, useState } from 'react';
import { useEditor } from '../../editor';
import { useStore } from '../../store';
import { Segmented } from '../../ui/fields';
import { AiSettingsDialog } from '../AiSettingsDialog';
import { LayoutsDialog } from '../LayoutsDialog';
import { aiSettings } from '../credentials';
import { BriefDialog } from './BriefDialog';
import { usd } from './spend';
import { endPreview, openPanel, useDesigner } from './state';

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
        Layouts: walls only, a few cents. Design: walls, furniture, paint and cost, about US$1–2.
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
  const run = useDesigner((s) => s.run);
  const panel = useDesigner((s) => s.panel);
  const selected = useDesigner((s) => s.selected);
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
        <span className="designer-bar-text">Previewing {preview.label}, not in your plan yet</span>
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
