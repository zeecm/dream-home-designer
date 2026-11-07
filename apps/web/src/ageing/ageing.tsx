import {
  type AgeingGroup,
  type AgeingIssue,
  type AgeingKind,
  type AgeingProfile,
  type AgeingReport,
  EASE_ELIGIBILITY,
  EASE_NOT_HDB,
  EASE_URL,
  FLAT_TYPES,
  type FlatType,
  type Level,
  type PlanGeometry,
  type Vec2,
  defaultFlatType,
  dollars,
  easeItems,
  furnitureKind,
  levelBounds,
  pointPosition,
  roomShapes,
  wallStatus,
} from '@dhd/core';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type LabelSpec, handleBoxes, pinchLabel, placeLabels } from '../clearance/clearance';
import { pointerHeld, startAgeing, useWalkways } from '../clearance/walkways';
import { type Selection, useEditor } from '../editor';
import { useSuggest } from '../electrical/suggest';
import { roomLabelBoxes } from '../plan/layers';
import { type Size, type View, fitBounds } from '../plan/view';
import { useStorage } from '../storage/store';
import { useLevel, useProject } from '../store';
import { Segmented } from '../ui/fields';
import { icons } from '../ui/icons';
import { formatLength } from '../units';
import { choiceOf, useAgeing } from './store';

/**
 * The ageing parents check in the editor: the "Older person" section in the plan details,
 * the list of what to look at (replacing the plan details; a half-height sheet on a phone),
 * the marks on the plan, a piece's or door's lines in its details, and the live region's
 * line after a drop. Spec: docs/specs/ageing-parents.md, slice 1; wording from the UX design.
 */

const PROFILES: { value: 'off' | AgeingProfile; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'walking', label: 'Walking aid' },
  { value: 'wheelchair', label: 'Wheelchair' },
];

/** Keeps the check in step with the project open and its setting (call it anywhere, often). */
export function useAgeingSync() {
  const projectId = useProject().id;
  const load = useAgeing((s) => s.load);
  useEffect(() => load(projectId), [projectId, load]);
  const setting = useAgeing((s) => s.setting);
  const ready = useAgeing((s) => s.projectId === projectId);
  useEffect(() => {
    if (ready) startAgeing(choiceOf(setting));
  }, [ready, setting]);
}

/** The ageing report for the level and version shown (null while off or not yet run). */
export function useAgeingReport(): AgeingReport | null {
  useAgeingSync();
  const on = useAgeing((s) => s.setting.profile !== 'off');
  const report = useWalkways((s) => s.ageing);
  const of = useWalkways((s) => s.level);
  const ofVariant = useWalkways((s) => s.variant);
  const level = useLevel();
  const variant = useEditor((s) => s.variant);
  return on && level && of?.id === level.id && ofVariant === variant ? report : null;
}

// --- words ----------------------------------------------------------------------------------

const who = (p: AgeingProfile) => (p === 'wheelchair' ? 'a wheelchair' : 'a walking aid');
const m = (x: number) => formatLength(x);
const roomName = (level: Level, id?: string) => (id && level.rooms[id]?.name) || 'a room';
const pieceName = (level: Level, id: string) =>
  `the ${furnitureKind(level.items[id]?.assetId ?? '')?.name ?? 'piece'}`;
const listed = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
const capital = (s: string) => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`;

/** A door's name: the main door, or the room it leads into. */
function doorName(level: Level, i: AgeingIssue): string {
  return i.group === 'in' ? 'Main door' : `${roomName(level, i.roomId)} door`;
}

/** A note for widening a door in a wall that can't simply be cut. */
function wallNote(level: Level, openingId?: string): string {
  const o = openingId ? level.openings[openingId] : undefined;
  if (!o) return '';
  const s = wallStatus(level, o.wallId);
  if (s === 'shelter') return ' This is a household shelter wall: it can’t be changed.';
  if (s === 'structural') {
    return ' This wall is structural: widening it needs HDB’s approval and may not be allowed. A sliding or pocket door gains the most width in the same opening.';
  }
  return '';
}

/** One line of the list, in words. `explain` adds what "clear" means (said once). */
export function ageingText(
  level: Level,
  i: AgeingIssue,
  profile: AgeingProfile,
  explain = false,
): string {
  const by = i.itemIds.map((id) => pieceName(level, id));
  const clearWord = explain ? 'clear (the gap with the door open)' : 'clear';
  switch (i.kind) {
    case 'door-width':
      return `${doorName(level, i)}: ${m(i.have)} ${clearWord}; ${who(profile)} needs ${i.group === 'in' ? '' : 'at least '}${m(i.need)}.${wallNote(level, i.openingId)}`;
    case 'door-space': {
      const alt = i.alt
        ? ` Or fit a wider door: a ${m(i.alt.clear)} opening needs only ${m(i.alt.need)} in front.`
        : '';
      const inIt = by.length
        ? ` ${capital(listed(by))} ${by.length > 1 ? 'are' : 'is'} in it.`
        : '';
      return `${doorName(level, i)}: ${m(i.clear ?? 0)} ${clearWord} needs ${m(i.need)} of space in front; ${m(i.have)} here.${inIt}${alt}`;
    }
    case 'entrance-space':
      return `Inside the main door: ${m(i.have)} clear in front; ${who(profile)} needs 1.25 × 1.50 m to turn in.${by.length ? ` ${capital(listed(by))} ${by.length > 1 ? 'are' : 'is'} in the way.` : ''}`;
    case 'latch-side':
      return `Inside the main door: ${by.length ? listed(by) : 'the wall'} leaves ${m(i.have)} beside the handle; ${who(profile)} needs ${m(i.need)} to reach it.`;
    case 'route': {
      const to = listed((i.to ?? []).map((id) => roomName(level, id)));
      if (i.flat) return `The corridor itself is ${m(i.have)} wide; ${m(i.need)} needed to ${to}.`;
      if (i.have <= 0)
        return `${capital(listed(by))} ${by.length > 1 ? 'close' : 'closes'} the way to ${to}.`;
      return `The way to ${to} is ${m(i.have)} at ${listed(by)}; ${m(i.need)} needed.`;
    }
    case 'turn': {
      const name = roomName(level, i.roomId);
      const bath = i.group === 'bathroom';
      if (!by.length) {
        return bath
          ? `No room to turn a wheelchair inside: ${m(i.have)} (${m(i.need)} recommended). Many HDB bathrooms can’t. A wheelchair can go in forwards and come out backwards if the door and the 1.00 m way to the toilet are clear.`
          : `${name} is ${m(i.have)} across inside, too small for a ${m(i.need)} turn.`;
      }
      const where = by.length > 1 ? `between ${listed(by)}` : `beside ${by[0]}`;
      return `No room to turn a wheelchair${bath ? ' inside' : ` in ${name}`}: ${m(i.have)} ${where} (${m(i.need)} recommended).`;
    }
    case 'bed':
      return `Getting into bed ${profile === 'wheelchair' ? 'from a wheelchair' : 'with a walking aid'} needs ${m(i.need)} along one side; ${m(i.have)} on the better side.`;
    case 'door-in':
      return `${doorName(level, i)} opens inwards: if they fall against it, it can’t be opened. A folding or sliding door, or one that opens out, is safer.`;
    case 'wc-front':
      return profile === 'wheelchair'
        ? `In front of the toilet: ${i.have.toFixed(2)} × ${m(i.have)} clear; 1.00 × 1.00 m needed to pull up beside it.`
        : `In front of the toilet: ${m(i.have)} clear; ${m(i.need)} needed.`;
    case 'wc-side':
      return `Beside the toilet: ${m(i.have)} from its centre to ${by.length ? listed(by) : 'the wall'}; ${m(i.need)} needed on one side for a grab bar.`;
    case 'wc-way':
      return `From the door to the toilet and basin: ${m(i.have)}${by.length ? ` at ${listed(by)}` : ''}; ${m(i.need)} needed.`;
    case 'reach': {
      let low = 0;
      let lowS = 0;
      let high = 0;
      let highS = 0;
      for (const id of i.pointIds ?? []) {
        const p = level.points?.[id];
        if (!p) continue;
        const h = p.wall?.height ?? 0;
        const sw = p.kind === 'switch';
        if (h < 0.45) sw ? lowS++ : low++;
        else sw ? highS++ : high++;
      }
      const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : w.endsWith('h') ? 'es' : 's'}`;
      const parts = [
        low ? `${n(low, 'socket')} below 0.45 m` : '',
        lowS ? `${n(lowS, 'switch')} below 0.45 m` : '',
        high ? `${n(high, 'socket')} above 1.20 m` : '',
        highS ? `${n(highS, 'switch')} above 1.20 m` : '',
      ].filter(Boolean);
      return `${capital(listed(parts))}: hard to reach from a wheelchair or for someone who can’t bend down.`;
    }
  }
}

const GROUP_TITLE: Record<Exclude<AgeingGroup, 'bedroom' | 'bathroom'>, string> = {
  in: 'Getting in',
  around: 'Getting around',
  points: 'Switches and sockets',
};

/** "Also checked" words, by group and check. */
const PASSED: Record<AgeingGroup, Partial<Record<AgeingKind, string>>> = {
  in: {
    'door-width': 'main door width',
    'entrance-space': 'space inside the door',
    'latch-side': 'room beside the handle',
  },
  around: {
    'door-width': 'door widths',
    'door-space': 'space in front of doors',
    route: 'the way through',
    turn: 'room to turn',
  },
  bedroom: {
    'door-width': 'its door',
    'door-space': 'space at its door',
    route: 'the way there',
    turn: 'room to turn',
    bed: 'room beside the bed',
  },
  bathroom: {
    'door-width': 'its door',
    'door-space': 'space at its door',
    'door-in': 'which way the door opens',
    route: 'the way there',
    turn: 'room to turn',
    'wc-front': 'space in front of the toilet',
    'wc-side': 'space beside the toilet',
    'wc-way': 'the way to the toilet and basin',
  },
  points: { reach: 'switch and socket heights' },
};

function alsoChecked(report: AgeingReport, g: AgeingGroup): string | null {
  const words = report.passed
    .filter((p) => p.group === g)
    .map((p) => PASSED[g][p.kind])
    .filter((w): w is string => !!w);
  const uniq = [...new Set(words)];
  if (!uniq.length) return null;
  return `Also checked: ${listed(uniq)} (${uniq.length > 1 ? 'all fine' : 'fine'}).`;
}

const NOTES: Record<AgeingReport['notes'][number], string> = {
  'no-main-door': 'Add the main door to check the way in.',
  'add-toilet': 'Add the toilet and basin (Bathroom in the catalogue) to check the bathroom.',
  'name-bathroom': 'Name a room Bath or WC to check the bathroom.',
};

/** Where each note goes: its group, or above them all. */
const NOTE_GROUP: Record<AgeingReport['notes'][number], AgeingGroup | null> = {
  'no-main-door': 'in',
  'add-toilet': 'bathroom',
  'name-bathroom': null,
};

/** "5 to look at for a wheelchair: 2 needed, 3 recommended", or that there is nothing. */
export function summaryLine(report: AgeingReport): string {
  const n = report.issues.length;
  if (!n) {
    return report.profile === 'wheelchair'
      ? 'Nothing to change in what’s checked: doors, the way through, turning, bathroom, switches.'
      : 'Nothing to change in what’s checked: doors, the way through, bathroom, switches.';
  }
  const needed = report.issues.filter((i) => i.level === 'needed').length;
  const rec = n - needed;
  const parts = [needed ? `${needed} needed` : '', rec ? `${rec} recommended` : ''].filter(Boolean);
  return `${n} to look at for ${who(report.profile)}: ${parts.join(', ')}`;
}

// --- going to a line ---------------------------------------------------------------------

/** What a line selects: its door, else its first piece, else its room or first point. */
function targetOf(i: AgeingIssue, step = 0): Selection | null {
  const doorKinds: AgeingKind[] = [
    'door-width',
    'door-space',
    'door-in',
    'entrance-space',
    'latch-side',
  ];
  if (i.openingId && doorKinds.includes(i.kind)) return { kind: 'opening', id: i.openingId };
  if (i.kind === 'reach' && i.pointIds?.length) {
    return { kind: 'point', id: i.pointIds[step % i.pointIds.length] as string };
  }
  if (i.itemIds[0]) return { kind: 'item', id: i.itemIds[0] };
  if (i.roomId && i.kind === 'turn') return { kind: 'room', id: i.roomId };
  return null;
}

function centreOf(level: Level, i: AgeingIssue, sel: Selection | null): Vec2 | null {
  if (sel?.kind === 'point') {
    const p = level.points?.[sel.id];
    const pos = p && pointPosition(level, p);
    if (pos) return pos.at;
  }
  const d = i.draw;
  if (d.circle) return d.circle.c;
  if (d.bar) return { x: (d.bar[0].x + d.bar[1].x) / 2, y: (d.bar[0].y + d.bar[1].y) / 2 };
  if (d.poly?.length) {
    return {
      x: d.poly.reduce((t, p) => t + p.x, 0) / d.poly.length,
      y: d.poly.reduce((t, p) => t + p.y, 0) / d.poly.length,
    };
  }
  const it = sel?.kind === 'item' ? level.items[sel.id] : undefined;
  return it ? { x: it.position.x, y: it.position.z } : null;
}

const pointSteps = new Map<string, number>();

/** Selects what a line is about and pans the plan to it (the list stays to come back to). */
export function showLine(level: Level, i: AgeingIssue) {
  const step = i.kind === 'reach' ? (pointSteps.get(i.key) ?? 0) : 0;
  if (i.kind === 'reach') pointSteps.set(i.key, step + 1);
  const sel = targetOf(i, step);
  const c = centreOf(level, i, sel);
  useAgeing.setState({ shown: i.key });
  const ed = useEditor.getState();
  if (c && ed.view) ed.setView({ ...ed.view, cx: c.x, cy: c.y }, true);
  ed.select(sel);
}

/** Show next: the line after the last one shown, in report order, wrapping. */
export function showNext(level: Level, report: AgeingReport) {
  if (!report.issues.length) return;
  const at = report.issues.findIndex((i) => i.key === useAgeing.getState().shown);
  const i = report.issues[(at + 1) % report.issues.length];
  if (i) showLine(level, i);
}

// --- the plan details' section ------------------------------------------------------------

/** "Older person": who the check is for, and its summary with the way to the list. */
export function OlderPersonSection() {
  const level = useLevel();
  const setting = useAgeing((s) => s.setting);
  const set = useAgeing((s) => s.set);
  const intro = useAgeing((s) => s.intro);
  const report = useAgeingReport();
  const h = useId();
  const on = setting.profile !== 'off';
  return (
    <section className="field ageing-entry" aria-labelledby={h}>
      <h3 id={h} className="section-title">
        Older person
      </h3>
      <div className="ageing-check-for">
        <span className="field-label" aria-hidden="true">
          Check for
        </span>
        <Segmented
          label="Check for"
          fill
          value={setting.profile}
          options={PROFILES}
          onChange={(v) => set({ profile: v })}
        />
      </div>
      {on && intro && <p className="field-hint">{INTRO}</p>}
      {on && report && level && (
        <div className="ageing-summary">
          <p className="ageing-summary-text" data-testid="ageing-summary">
            {summaryLine(report)}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-small"
              data-ageing-open=""
              onClick={() => {
                useSuggest.getState().close();
                useStorage.getState().closePanel();
                useAgeing.getState().openList();
              }}
            >
              See the list
            </button>
            {report.issues.length > 0 && (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => showNext(level, report)}
              >
                Show next
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const INTRO =
  'Checks doors, the way through, room to turn, the bathroom and switch heights for a walking aid or wheelchair, now or later. Choose Wheelchair to plan ahead. Older flats weren’t built to today’s code: treat this as a goal for the renovation.';

// --- the list -------------------------------------------------------------------------------

const returnFocus = () =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLButtonElement>('[data-ageing-open]')?.focus(),
  );

function Tag({ level }: { level: AgeingIssue['level'] }) {
  return (
    <span className={`ageing-tag ageing-tag-${level === 'needed' ? 'needed' : 'advise'}`}>
      {level === 'needed' ? 'Needed' : 'Recommended'}
    </span>
  );
}

/** The results: by group, each line a button to its place on the plan, then EASE. */
export function AgeingPanel() {
  const level = useLevel();
  const report = useAgeingReport();
  const setting = useAgeing((s) => s.setting);
  const set = useAgeing((s) => s.set);
  const intro = useAgeing((s) => s.intro);
  const shown = useAgeing((s) => s.shown);
  const heading = useRef<HTMLHeadingElement>(null);
  const [change, setChange] = useState(false);
  // Opened: from its top (the plan details may have been scrolled), focus on its heading.
  useEffect(() => {
    heading.current?.closest('.inspector')?.scrollTo?.({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, []);
  // Back from a line: focus returns to it.
  useEffect(() => {
    if (!shown) return;
    const el = document.querySelector<HTMLButtonElement>(
      `[data-ageing-line="${CSS.escape(shown)}"]`,
    );
    el?.focus({ preventScroll: false });
  }, [shown]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useEditor.getState().selection || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      useAgeing.getState().closeList();
      returnFocus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const close = () => {
    useAgeing.getState().closeList();
    returnFocus();
  };
  const allBedrooms = useBedrooms(level, report);
  if (!level) return null;
  const profile = setting.profile === 'off' ? null : setting.profile;
  const bedrooms = report
    ? report.bedrooms.length
      ? report.bedrooms.map((b) => b.roomId)
      : report.bedroom
        ? [report.bedroom]
        : []
    : [];
  const autoName = report?.bathroom && report.bathroomAuto ? roomName(level, report.bathroom) : '';
  let explained = false;
  const line = (i: AgeingIssue) => {
    const explain = !explained && (i.kind === 'door-width' || i.kind === 'door-space');
    if (explain) explained = true;
    return (
      <li key={i.key}>
        <button
          type="button"
          className={`ageing-line${shown === i.key ? ' ageing-line-shown' : ''}`}
          data-ageing-line={i.key}
          data-testid="ageing-line"
          onClick={() => showLine(level, i)}
        >
          <Tag level={i.level} />
          <span>{profile ? ageingText(level, i, profile, explain) : ''}</span>
        </button>
      </li>
    );
  };
  const group = (g: AgeingGroup, title: string) => {
    if (!report) return null;
    const lines = report.issues.filter((i) => i.group === g);
    const also = alsoChecked(report, g);
    const notes = report.notes.filter((n) => NOTE_GROUP[n] === g);
    if (!lines.length && !also && !notes.length) return null;
    return (
      <section key={g} className="ageing-group" aria-label={title}>
        <h3 className="section-title">{title}</h3>
        {notes.map((n) => (
          <p key={n} className="ageing-note">
            {NOTES[n]}
          </p>
        ))}
        {lines.length > 0 && <ul className="ageing-lines">{lines.map(line)}</ul>}
        {also && <p className="ageing-also">{also}</p>}
      </section>
    );
  };
  const oneLine = [
    PROFILES.find((p) => p.value === setting.profile)?.label,
    report?.bedroom ? roomName(level, report.bedroom) : 'Bedroom not chosen',
    report?.bathroom ? roomName(level, report.bathroom) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section className="ageing" aria-labelledby="ageing-h">
      <div className="inspector-head ageing-head">
        <h2 id="ageing-h" className="panel-title" ref={heading} tabIndex={-1}>
          Older person
        </h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close the older person list"
          title="Close (Esc)"
          onClick={close}
        >
          {icons.close}
        </button>
      </div>
      <p className="ageing-oneline">
        <span>{oneLine}</span>
        <button
          type="button"
          className="link-btn"
          aria-expanded={change}
          onClick={() => setChange(!change)}
        >
          {change ? 'Done' : 'Change'}
        </button>
      </p>
      <div className={`ageing-rows${change ? ' ageing-rows-open' : ''}`}>
        <div className="ageing-row">
          <span className="field-label" aria-hidden="true">
            Check for
          </span>
          <Segmented
            label="Check for"
            fill
            value={setting.profile}
            options={PROFILES}
            onChange={(v) => set({ profile: v })}
          />
        </div>
        <label className="ageing-row">
          <span className="field-label">Bedroom</span>
          <select
            className="input"
            value={report?.bedroom ?? ''}
            onChange={(e) => set({ bedroomId: e.target.value || undefined })}
          >
            <option value="">Choose…</option>
            {allBedrooms.map((id) => (
              <option key={id} value={id}>
                {roomName(level, id)}
              </option>
            ))}
          </select>
        </label>
        <label className="ageing-row">
          <span className="field-label">Bathroom</span>
          <select
            className="input"
            value={report && !report.bathroomAuto ? (report.bathroom ?? '') : ''}
            onChange={(e) => set({ bathroomId: e.target.value || undefined })}
          >
            <option value="">{autoName ? `Auto: ${autoName}` : 'Auto'}</option>
            {(report?.bathrooms ?? []).map((id) => (
              <option key={id} value={id}>
                {roomName(level, id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {intro && <p className="ageing-intro">{INTRO}</p>}
      <div className="ageing-body">
        {!report ? (
          <p className="ageing-empty">Checking…</p>
        ) : (
          <>
            {report.notes
              .filter((n) => !NOTE_GROUP[n])
              .map((n) => (
                <p key={n} className="ageing-note">
                  {NOTES[n]}
                </p>
              ))}
            {group('in', GROUP_TITLE.in)}
            {group('around', GROUP_TITLE.around)}
            {!report.bedroom && bedrooms.length > 0 && (
              <section className="ageing-group" aria-labelledby="ageing-which">
                <h3 id="ageing-which" className="section-title">
                  Which bedroom to check?
                </h3>
                <ul className="ageing-lines">
                  {report.bedrooms.map((b) => (
                    <li key={b.roomId}>
                      <button
                        type="button"
                        className="ageing-line ageing-choose"
                        aria-label={`${roomName(level, b.roomId)}: ${b.count ? `${b.count} to look at` : 'nothing to change'}`}
                        onClick={() => set({ bedroomId: b.roomId })}
                      >
                        <span className="ageing-choose-name">{roomName(level, b.roomId)}</span>
                        <span className="num">
                          {b.count ? `${b.count} to look at` : 'nothing to change'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {report.bedroom && group('bedroom', `Bedroom: ${roomName(level, report.bedroom)}`)}
            {report.bathroom && group('bathroom', `Bathroom: ${roomName(level, report.bathroom)}`)}
            {group('points', GROUP_TITLE.points)}
            {report.issues.length === 0 && <p className="ageing-empty">{summaryLine(report)}</p>}
            <EasePanel level={level} report={report} />
          </>
        )}
      </div>
      <div className="ageing-foot">
        {report && report.issues.length > 0 && (
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => showNext(level, report)}
          >
            Show next
          </button>
        )}
        <button type="button" className="btn btn-block" onClick={close}>
          Close
        </button>
      </div>
    </section>
  );
}

/** The bedrooms to choose from (the report lists them only before one is chosen). */
function useBedrooms(level: Level | undefined, report: AgeingReport | null): string[] {
  return useMemo(() => {
    if (!report || !level) return [];
    if (report.bedrooms.length) return report.bedrooms.map((b) => b.roomId);
    const shapes = roomShapes(level);
    const named = Object.values(level.rooms)
      .filter((r) => shapes.has(r.id) && /bed|master|guest/i.test(r.name))
      .map((r) => r.id);
    return report.bedroom && !named.includes(report.bedroom) ? [report.bedroom, ...named] : named;
  }, [level, report]);
}

/** What HDB's EASE can fit here, with the owner's share for the flat type. */
function EasePanel({ level, report }: { level: Level; report: AgeingReport }) {
  const setting = useAgeing((s) => s.setting);
  const set = useAgeing((s) => s.set);
  const type: FlatType = setting.flatType ?? defaultFlatType(level);
  const bathDoor = report.issues.find(
    (i) => i.group === 'bathroom' && (i.kind === 'door-width' || i.kind === 'door-space'),
  );
  const items = easeItems(type, {
    bathrooms: report.bathrooms.length,
    doorFails: !!bathDoor,
  });
  const because = (w: string): string | null => {
    if (w === 'second-bathroom') return `Because there are ${report.bathrooms.length} bathrooms`;
    if (w === 'door' && bathDoor) {
      return bathDoor.kind === 'door-width'
        ? `Because ${roomName(level, bathDoor.roomId)}’s door is ${m(bathDoor.have)} clear`
        : `Because ${roomName(level, bathDoor.roomId)}’s door needs more space in front`;
    }
    return null;
  };
  return (
    <section className="ageing-group ageing-ease" aria-labelledby="ease-h">
      <h3 id="ease-h" className="section-title">
        What HDB’s EASE can fit here
      </h3>
      <label className="ageing-row">
        <span className="field-label">Flat type</span>
        <select
          className="input"
          value={type}
          onChange={(e) => set({ flatType: e.target.value as FlatType })}
        >
          {FLAT_TYPES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {type === 'none' ? (
        <p className="ageing-also">{EASE_NOT_HDB}</p>
      ) : (
        <>
          <table className="ease-table" data-testid="ease-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="num">
                  You pay
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ item, cents, because: w }) => {
                const why = because(w);
                return (
                  <tr key={item.id} data-ease={item.id}>
                    <td>
                      {item.name}
                      {why && <span className="ease-why">{why}</span>}
                    </td>
                    <td className="num">{dollars(cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="ageing-also">
            {EASE_ELIGIBILITY}{' '}
            <a href={EASE_URL} target="_blank" rel="noreferrer">
              And more on HDB’s EASE page ↗
            </a>
          </p>
        </>
      )}
    </section>
  );
}

/** At the top of a piece's or door's details opened from the list: the way back to it. */
export function AgeingBack() {
  const level = useLevel();
  const report = useAgeingReport();
  const shown = useAgeing((s) => s.shown);
  if (!level || !report) return null;
  const at = report.issues.findIndex((i) => i.key === shown);
  return (
    <button
      type="button"
      className="link-btn ageing-back"
      onClick={() => useEditor.getState().select(null)}
    >
      ‹ Back to the list
      {at >= 0 ? ` (${at + 1} of ${report.issues.length})` : ''}
    </button>
  );
}

/** A piece's or door's lines in its details: "For a wheelchair". */
export function ItemAgeing({
  level,
  id,
  kind,
}: { level: Level; id: string; kind: 'item' | 'opening' }) {
  const report = useAgeingReport();
  const h = useId();
  if (!report) return null;
  const mine = report.issues.filter((i) =>
    kind === 'item' ? i.itemIds.includes(id) : i.openingId === id,
  );
  if (!mine.length) return null;
  return (
    <section className="stack" aria-labelledby={h} data-testid="item-ageing">
      <h3 id={h} className="section-title">
        For {who(report.profile)}
      </h3>
      <ul className="ageing-lines ageing-lines-plain">
        {mine.map((i) => (
          <li key={i.key}>
            <Tag level={i.level} />
            <span>{ageingText(level, i, report.profile)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The live region's addition after a drop or move: the piece's first ageing line. */
export function AgeingAnnouncement({
  level,
  selection,
}: { level: Level; selection: Selection | null }) {
  const report = useAgeingReport();
  const released = useWalkways((s) => s.released);
  const id = selection?.kind === 'item' ? selection.id : null;
  const first = useMemo(() => {
    if (!report || !id) return null;
    const i = report.issues.find((x) => x.itemIds.includes(id));
    return i ? ageingText(level, i, report.profile) : null;
  }, [report, id, level]);
  const [text, setText] = useState('');
  const said = useRef<{ id: string | null; released: number; first: string | null }>({
    id: null,
    released,
    first: null,
  });
  useEffect(() => {
    const prev = said.current;
    if (prev.id !== id) {
      said.current = { id, released, first };
      setText(first ? ` ${first}` : '');
      return;
    }
    if (pointerHeld() || released === prev.released) return;
    said.current = { id, released, first };
    if (first && first !== prev.first) setText(` ${first}`);
    else if (!first) setText('');
  }, [id, released, first]);
  return text ? <>{text}</> : null;
}

// --- on the plan ----------------------------------------------------------------------------

const pts = (ps: Vec2[]) => ps.map((p) => `${p.x},${p.y}`).join(' ');
const chip = (have: number, need: number, flat?: boolean) =>
  `${have <= 0 ? 'Closed' : have.toFixed(2)} / ${formatLength(need)}${flat ? ' · walls' : ''}`;

/**
 * Over the plan: what's short, red when needed and amber when recommended (a dashed bar is
 * the flat's own walls); turning circles and toilet zones that pass only when their room is
 * selected. Left out of pictures and prints.
 */
export const AgeingLayer = memo(function AgeingLayer({
  level,
  geom,
  view,
  size,
}: {
  level: Level;
  geom: PlanGeometry;
  view: View;
  size: Size;
}) {
  const report = useAgeingReport();
  const selection = useEditor((s) => s.selection);
  const shown = useAgeing((s) => s.shown);
  const listOpen = useAgeing((s) => s.listOpen);
  const fitAll = useAgeing((s) => s.fitAll);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening, and the resizes after it
  useEffect(() => {
    if (!fitAll || Date.now() - fitAll > 1000 || size.width === 0) return;
    const frame = requestAnimationFrame(() =>
      useEditor.getState().setView(fitBounds(levelBounds(level), size, 12), true),
    );
    return () => cancelAnimationFrame(frame);
  }, [fitAll, size]);
  const selectedRoom = selection?.kind === 'room' ? selection.id : null;
  const shownIssue = report?.issues.find((i) => i.key === shown);
  const specs = useMemo(() => {
    const out: LabelSpec[] = [];
    if (!report) return out;
    for (const i of report.issues) {
      const text = chip(i.have, i.need, i.flat);
      if (i.draw.bar && i.kind !== 'door-in') {
        out.push({ ...pinchLabel(`a-${i.key}`, i.draw.bar, i.have, i.need), text });
      } else if (i.draw.circle) {
        const { c, r } = i.draw.circle;
        out.push({
          key: `a-${i.key}`,
          text,
          have: i.have,
          need: i.need,
          spots: [
            { at: { x: c.x, y: c.y - r }, n: { x: 0, y: -1 }, gap: 4 },
            { at: { x: c.x, y: c.y + r }, n: { x: 0, y: 1 }, gap: 4 },
            { at: c, n: { x: 0, y: -1 }, gap: -8 },
          ],
        });
      } else if (i.draw.poly?.length) {
        const p = i.draw.poly;
        const c = {
          x: p.reduce((t, q) => t + q.x, 0) / p.length,
          y: p.reduce((t, q) => t + q.y, 0) / p.length,
        };
        out.push({
          key: `a-${i.key}`,
          text,
          have: i.have,
          need: i.need,
          spots: [
            { at: c, n: { x: 0, y: -1 }, gap: -8 },
            { at: c, n: { x: 0, y: 1 }, gap: 10 },
          ],
        });
      }
    }
    return out;
  }, [report]);
  if (!report) return null;
  const visible = {
    x0: view.cx - size.width / 2 / view.zoom,
    y0: view.cy - size.height / 2 / view.zoom,
    x1: view.cx + size.width / 2 / view.zoom,
    y1: view.cy + size.height / 2 / view.zoom,
  };
  const selected = selection?.kind === 'item' ? level.items[selection.id] : undefined;
  const labels = placeLabels(
    specs,
    view.zoom,
    visible,
    roomLabelBoxes(level, geom, view.zoom),
    selected ? handleBoxes(selected, view.zoom) : [],
  );
  const px = 1 / view.zoom;
  const levelOf = new Map(report.issues.map((i) => [`a-${i.key}`, i]));
  const tone = (i: AgeingIssue) => (i.level === 'needed' ? 'ageing-needed' : 'ageing-advise');
  // Passes: only for the room selected (or the bathroom whose line was just shown).
  const fineTurns = report.turns.filter(
    (t) => t.ok && selectedRoom && t.roomIds.includes(selectedRoom),
  );
  const toiletShown =
    report.toilet &&
    (selectedRoom === report.toilet.roomId ||
      (listOpen && shownIssue?.group === 'bathroom' && shownIssue.roomId === report.toilet.roomId));
  const drawnPolys = new Set(report.issues.flatMap((i) => (i.draw.poly ? [pts(i.draw.poly)] : [])));
  return (
    <g className="ageing-marks" pointerEvents="none" data-export="skip" data-testid="ageing-layer">
      {fineTurns.map((t) => (
        <g key={t.key} className="ageing-fine" data-testid="ageing-turn-fine">
          <circle cx={t.c.x} cy={t.c.y} r={t.have / 2} />
          <text className="num" x={t.c.x} y={t.c.y + 4 * px} textAnchor="middle" fontSize={11 * px}>
            {formatLength(t.have)}
          </text>
        </g>
      ))}
      {toiletShown &&
        report.toilet &&
        [report.toilet.front, report.toilet.side]
          .filter((p) => !drawnPolys.has(pts(p)))
          .map((p) => <polygon key={pts(p)} className="ageing-fine-zone" points={pts(p)} />)}
      {report.issues.map((i) => {
        const cls = `${tone(i)}${i.flat ? ' ageing-flat' : ''}`;
        const d = i.draw;
        return (
          <g key={i.key} className={cls} data-ageing={i.kind}>
            {d.poly && <polygon points={pts(d.poly)} />}
            {d.circle && <circle cx={d.circle.c.x} cy={d.circle.c.y} r={d.circle.r} />}
            {d.bar && <Bar bar={d.bar} px={px} />}
            {i.kind === 'reach' &&
              (i.pointIds ?? []).map((id) => {
                const p = level.points?.[id];
                const pos = p && pointPosition(level, p);
                return pos ? (
                  <circle
                    key={id}
                    className="ageing-ring"
                    cx={pos.at.x}
                    cy={pos.at.y}
                    r={12 * px}
                  />
                ) : null;
              })}
          </g>
        );
      })}
      {labels.map((l) => {
        const i = levelOf.get(l.key);
        return (
          <g key={l.key} className={`ageing-chip ${i ? tone(i) : ''}`} data-testid="ageing-chip">
            <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={4 * px} />
            <text
              className="num"
              x={l.x + l.w / 2}
              y={l.y + l.h / 2 + 4 * px}
              textAnchor="middle"
              fontSize={11 * px}
            >
              {l.text}
            </text>
          </g>
        );
      })}
    </g>
  );
});

function Bar({ bar, px }: { bar: [Vec2, Vec2]; px: number }) {
  const [p, q] = bar;
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const t = { x: (-(q.y - p.y) / len) * 4 * px, y: ((q.x - p.x) / len) * 4 * px };
  return (
    <g className="ageing-bar">
      <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
      {[p, q].map((e, j) => (
        <line
          key={j === 0 ? 'a' : 'b'}
          x1={e.x - t.x}
          y1={e.y - t.y}
          x2={e.x + t.x}
          y2={e.y + t.y}
        />
      ))}
    </g>
  );
}
