import { EYE_HEIGHT, type Level, type Vec2, collisionSegments, walk, walkStart } from '@dhd/core';
import { useFrame, useThree } from '@react-three/fiber';
import { type MutableRefObject, useEffect, useMemo, useRef } from 'react';
import type { PerspectiveCamera, PointLight } from 'three';
import { useEditor } from '../editor';
import { footstep } from './footsteps';
import { useWalkFov, verticalFov } from './fov';

/** Joystick input, each axis -1..1: x strafes right, y walks forward. */
export type StickInput = MutableRefObject<Vec2>;

/** Where the walker is and which way they face (plan space; yaw from +x towards +y). */
export interface WalkPose {
  at: Vec2;
  yaw: number;
  pitch: number;
}

const WALK_SPEED = 1.4; // m/s, an ordinary walk
const RUN_SPEED = 3;
const LOOK_SPEED = 0.0025; // radians per pixel
const MAX_PITCH = 1.3;
/**
 * How fast a look stick's tilt (-1..1) turns, as a share of full speed: nothing in the middle
 * (a resting thumb doesn't drift), then squared, so a small tilt turns slowly for aiming and a
 * full one swings round.
 */
export function stickRate(tilt: number): number {
  const DEAD = 0.12;
  const a = Math.abs(tilt);
  if (a <= DEAD) return 0;
  const k = Math.min(1, (a - DEAD) / (1 - DEAD));
  return Math.sign(tilt) * k * k;
}
/** The look stick at full tilt turns this fast (radians per second); gentler near the middle. */
const STICK_TURN = 2.2;
/** Head bob: up and down once per step of this length, by this much. */
const STEP_LENGTH = 0.7;
const BOB_HEIGHT = 0.02;

const FORWARD = new Set(['KeyW', 'ArrowUp']);
const BACK = new Set(['KeyS', 'ArrowDown']);
const LEFT = new Set(['KeyA', 'ArrowLeft']);
const RIGHT = new Set(['KeyD', 'ArrowRight']);
const MOVE_KEYS = new Set([...FORWARD, ...BACK, ...LEFT, ...RIGHT, 'ShiftLeft', 'ShiftRight']);

/**
 * Keys a focused control takes for itself: all of them in a text field, the arrows on a
 * slider (the View or Time slider just used keeps focus; WASD and Esc still walk and leave).
 */
export const ownsKey = (t: EventTarget | null, key: string) =>
  // A dialog open over the walk (a render) has its keys to itself, Esc to close it included.
  (t instanceof Element && !!t.closest('dialog')) ||
  (t instanceof HTMLInputElement && t.type === 'range'
    ? key.startsWith('Arrow') || key === 'Home' || key === 'End'
    : isTyping(t));

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * First-person controls: WASD or the arrow keys (Shift to run) or the touch stick to move;
 * mouse look under pointer lock (click the view), or drag to look. Collision is the plan's
 * walls in 2D (`walk` in core), so doors and openings are the way through. Esc leaves.
 */
export function WalkControls({
  level,
  stick,
  lookStick,
  pose,
  paused = false,
  initial,
  onLeave,
}: {
  level: Level;
  stick: StickInput;
  /** The look stick (touch screens): x turns right, y looks up. */
  lookStick?: StickInput;
  /** Shared with the mini-map, which reads it every frame. */
  pose: MutableRefObject<WalkPose | null>;
  /**
   * Stand still: no walking or looking (a render's dialog is open, and the picture is of the
   * view as it was). The pose and lens are kept, so the walk carries on from there.
   */
  paused?: boolean;
  /** Where to start (the last walk's spot), or null for the plan's start point. */
  initial?: () => WalkPose | null;
  /** Told where the walk ended, however it ended (Esc, another view, another plan). */
  onLeave?: (pose: WalkPose) => void;
}) {
  const { camera, gl } = useThree();
  const view = useThree((s) => s.size);
  const across = useWalkFov();
  const segments = useMemo(() => collisionSegments(level), [level]);
  if (!pose.current) {
    const start = walkStart(level);
    const resumed = initial?.();
    // Back where the last walk ended, facing the same way but looking level.
    pose.current = (resumed && { ...resumed, pitch: 0 }) ?? {
      at: start?.at ?? { x: 0, y: 0 },
      yaw: start?.heading ?? 0,
      pitch: 0,
    };
  }
  const keys = useRef(new Set<string>());
  const leave = useRef(onLeave);
  leave.current = onLeave;
  const still = useRef(paused);
  still.current = paused;
  // Hold on to the pose object itself: the canvas has its own renderer, so the parent can
  // clear its ref before this cleanup runs.
  useEffect(() => {
    const walked = pose.current;
    return () => {
      if (walked) leave.current?.(walked);
    };
  }, [pose]);

  // The eye's field of view, set across the view whatever its shape; the orbit view's lens
  // comes back on leaving.
  useEffect(() => {
    const cam = camera as PerspectiveCamera;
    const fov = cam.fov;
    const near = cam.near;
    const shape = view.width / Math.max(view.height, 1);
    cam.fov = verticalFov(across, shape);
    // A wide view's near plane reaches further out at its corners: close enough in that
    // looking down beside a wall doesn't clip it.
    cam.near = 0.02;
    cam.updateProjectionMatrix();
    return () => {
      cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    };
  }, [camera, across, view.width, view.height]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (ownsKey(e.target, e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      // Esc is the viewport's (it works before these controls are up, in a 3D view loading).
      if (!MOVE_KEYS.has(e.code)) return;
      keys.current.add(e.code);
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => {
    const el = gl.domElement;
    // The orbit controls leave `touch-action: auto` on the canvas as they go, and with it a
    // phone takes a sideways swipe for a page pan and cancels it: looking needs `none`.
    const touchAction = el.style.touchAction;
    el.style.touchAction = 'none';
    const look = (dx: number, dy: number, speed = LOOK_SPEED) => {
      const p = pose.current;
      if (!p || still.current) return;
      p.yaw += dx * speed;
      p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p.pitch - dy * speed));
    };
    // A finger turns by the screen, not by the pixel: a swipe across the view is half a turn,
    // so a phone can look all round in two swipes, standing still.
    const touchSpeed = () => Math.PI / Math.max(200, el.clientWidth);
    /**
     * A drag's turn: the view turns the way the finger or mouse moves (right looks right, up
     * looks up), as in a game, not dragging the scene along as a map does.
     */
    const turn = (d: { x: number; y: number; touch: boolean }, e: PointerEvent) => {
      look(e.clientX - d.x, e.clientY - d.y, d.touch ? touchSpeed() : LOOK_SPEED);
    };
    let drag: { id: number; x: number; y: number; touch: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && !document.pointerLockElement) {
        // Pointer lock where the browser allows it; dragging works either way.
        Promise.resolve(el.requestPointerLock?.()).catch(() => {});
      }
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
      // Under pointer lock there is nothing to capture (and the browser throws).
      if (!document.pointerLockElement) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // a pointer that has already gone
        }
      }
    };
    const onMove = (e: PointerEvent) => {
      if (document.pointerLockElement === el) {
        look(e.movementX, e.movementY);
        return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      turn(drag, e);
      drag = { ...drag, x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      // A busy page can merge a quick swipe's moves into the lift: count its last stretch too.
      if (document.pointerLockElement !== el) {
        turn(drag, e);
      }
      drag = null;
    };
    // A cancelled touch (the system took it) has no position worth turning to.
    const onCancel = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) drag = null;
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      if (document.pointerLockElement === el) document.exitPointerLock();
      el.style.touchAction = touchAction;
    };
  }, [gl, pose]);

  // A soft light carried at head height: near walls read brighter than far ones, which gives
  // the rooms depth that flat ambient light doesn't.
  const lamp = useRef<PointLight>(null);
  const bob = useRef({ phase: 0, amp: 0 });
  const reducedMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    [],
  );

  useFrame((_, dt) => {
    const p = pose.current;
    if (!p || still.current) return;
    const ls = lookStick?.current;
    if (ls && (ls.x !== 0 || ls.y !== 0)) {
      const t = Math.min(dt, 0.1) * STICK_TURN;
      p.yaw += stickRate(ls.x) * t;
      p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p.pitch + stickRate(ls.y) * t * 0.6));
    }
    const k = keys.current;
    const has = (set: Set<string>) => [...set].some((c) => k.has(c));
    let forward = (has(FORWARD) ? 1 : 0) - (has(BACK) ? 1 : 0) + stick.current.y;
    let strafe = (has(RIGHT) ? 1 : 0) - (has(LEFT) ? 1 : 0) + stick.current.x;
    const len = Math.hypot(forward, strafe);
    if (len > 1) {
      forward /= len;
      strafe /= len;
    }
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;
    const step = speed * Math.min(dt, 0.1);
    // Plan (x, y) is world (x, z); facing +x with +y up, the right hand points to +z.
    const f = { x: Math.cos(p.yaw), y: Math.sin(p.yaw) };
    const r = { x: -f.y, y: f.x };
    const delta = {
      x: (f.x * forward + r.x * strafe) * step,
      y: (f.y * forward + r.y * strafe) * step,
    };
    // Walking with no input still settles the walker if an edit moved a wall onto it.
    const was = p.at;
    p.at = walk(segments, p.at, delta);
    // A gentle head bob with each step, easing in and out as walking starts and stops.
    const moved = Math.hypot(p.at.x - was.x, p.at.y - was.y);
    const b = bob.current;
    const stepsBefore = Math.floor(b.phase / Math.PI);
    b.phase += (moved / STEP_LENGTH) * Math.PI;
    // A footstep each time a foot comes down (half a bob).
    if (Math.floor(b.phase / Math.PI) > stepsBefore) footstep(speed === RUN_SPEED ? 1.4 : 1);
    const target = moved > 1e-4 && !reducedMotion ? BOB_HEIGHT : 0;
    b.amp += (target - b.amp) * Math.min(1, dt * 8);
    const eye = level.elevation + EYE_HEIGHT + Math.sin(b.phase) * b.amp;
    camera.position.set(p.at.x, eye, p.at.y);
    lamp.current?.position.set(p.at.x, eye + 0.3, p.at.y);
    camera.lookAt(
      p.at.x + Math.cos(p.yaw) * Math.cos(p.pitch),
      eye + Math.sin(p.pitch),
      p.at.y + Math.sin(p.yaw) * Math.cos(p.pitch),
    );
  });

  return <pointLight ref={lamp} intensity={6} distance={9} decay={1.6} />;
}
