import { isBoundary } from '@dhd/core';
import { useEffect, useState } from 'react';
import { useEditor } from '../editor';
import { endGuide, hasWalked, isGuided, markWalked } from '../guide';
import { useLevel, useProject, useStore } from '../store';
import { icons } from './icons';

interface Step {
  title: string;
  how: string;
  done: boolean;
  action?: { label: string; run: () => void };
}

/**
 * Getting started, over a new blank plan: picture, scale, walls, a room, a walk. One step
 * at a time, ticked off by doing it; closes itself once the walk has happened.
 */
export function Guide() {
  const id = useProject().id;
  const underlay = useProject().underlay;
  const level = useLevel();
  const role = useStore((s) => s.role);
  const calibrated = useStore((s) =>
    s.editor.history.past.some((e) => e.label === 'Calibrate plan image'),
  );
  const walking = useEditor((s) => !!s.walking);
  const { setTool, startWalk } = useEditor.getState();
  const [on, setOn] = useState(() => isGuided(id));
  const [walked, setWalked] = useState(() => hasWalked(id));
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    setOn(isGuided(id));
    setWalked(hasWalked(id));
  }, [id]);
  useEffect(() => {
    if (walking && on) {
      markWalked(id);
      setWalked(true);
    }
  }, [walking, on, id]);
  if (!on || !level || role === 'viewer') return null;

  const walls = Object.values(level.walls).filter((w) => !isBoundary(w)).length;
  const rooms = Object.keys(level.rooms).length;
  const steps: Step[] = [
    {
      title: 'Add your floor plan',
      how: 'Upload a photo, scan or PDF of it to trace over, or skip this and draw.',
      done: !!underlay || walls > 0 || skipped,
      action: {
        label: 'Draw instead',
        run: () => {
          setSkipped(true);
          setTool('wall');
        },
      },
    },
    {
      title: 'Set its scale',
      how: 'Pick Set scale, draw a line over a length you know, and type it in.',
      // Without a picture there is nothing to scale.
      done: calibrated || walls > 0 || !underlay,
      action: { label: 'Set scale', run: () => setTool('calibrate') },
    },
    {
      title: 'Draw the walls around a room',
      how: 'Drag from corner to corner, or tap or click each corner; close the loop and a room appears.',
      done: rooms > 0,
      action: { label: 'Draw walls', run: () => setTool('wall') },
    },
    {
      title: 'Walk through it',
      how: 'See it from the inside: walk with the thumb stick or WASD, and drag to look around.',
      done: walked,
      action: { label: 'Walk through', run: startWalk },
    },
  ];
  const at = steps.findIndex((s) => !s.done);
  const close = () => {
    endGuide(id);
    setOn(false);
  };
  if (at === -1) {
    return (
      <output className="guide guide-done">
        <span>
          <strong>That’s the basics.</strong> Add doors, windows and furniture from the tools.
        </span>
        <button type="button" className="btn btn-small" onClick={close}>
          Done
        </button>
      </output>
    );
  }
  const step = steps[at] as Step;
  return (
    <section className="guide" aria-label="Getting started">
      <span className="guide-count num" aria-hidden="true">
        {at + 1}/{steps.length}
      </span>
      <span className="guide-text">
        <strong>{step.title}.</strong> {step.how}
      </span>
      {step.action && (
        <button type="button" className="btn btn-small btn-primary" onClick={step.action.run}>
          {step.action.label}
        </button>
      )}
      <button
        type="button"
        className="icon-btn"
        aria-label="Close the getting-started guide"
        onClick={close}
      >
        {icons.close}
      </button>
    </section>
  );
}
