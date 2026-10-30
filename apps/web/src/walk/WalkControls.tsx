import { EYE_HEIGHT, type Level, type Vec2, collisionSegments, walk, walkStart } from '@dhd/core';
import { useFrame, useThree } from '@react-three/fiber';
import { type MutableRefObject, useEffect, useMemo, useRef } from 'react';
import type { PerspectiveCamera, PointLight } from 'three';
import { useEditor } from '../editor';

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
const WALK_FOV = 70;
/** Head bob: up and down once per step of this length, by this much. */
const STEP_LENGTH = 0.7;
const BOB_HEIGHT = 0.02;

const FORWARD = new Set(['KeyW', 'ArrowUp']);
const BACK = new Set(['KeyS', 'ArrowDown']);
const LEFT = new Set(['KeyA', 'ArrowLeft']);
const RIGHT = new Set(['KeyD', 'ArrowRight']);
const MOVE_KEYS = new Set([...FORWARD, ...BACK, ...LEFT, ...RIGHT, 'ShiftLeft', 'ShiftRight']);

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
  pose,
  initial,
  onLeave,
}: {
  level: Level;
  stick: StickInput;
  /** Shared with the mini-map, which reads it every frame. */
  pose: MutableRefObject<WalkPose | null>;
  /** Where to start (the last walk's spot), or null for the plan's start point. */
  initial?: () => WalkPose | null;
  /** Told where the walk ended, however it ended (Esc, another view, another plan). */
  onLeave?: (pose: WalkPose) => void;
}) {
  const { camera, gl } = useThree();
  const segments = useMemo(() => collisionSegments(level), [level]);
  if (!pose.current) {
    const start = walkStart(level);
    pose.current = initial?.() ?? {
      at: start?.at ?? { x: 0, y: 0 },
      yaw: start?.heading ?? 0,
      pitch: 0,
    };
  }
  const keys = useRef(new Set<string>());
  const leave = useRef(onLeave);
  leave.current = onLeave;
  // Hold on to the pose object itself: the canvas has its own renderer, so the parent can
  // clear its ref before this cleanup runs.
  useEffect(() => {
    const walked = pose.current;
    return () => {
      if (walked) leave.current?.(walked);
    };
  }, [pose]);

  // A wider lens indoors; the orbit view's lens comes back on leaving.
  useEffect(() => {
    const cam = camera as PerspectiveCamera;
    const fov = cam.fov;
    cam.fov = WALK_FOV;
    cam.updateProjectionMatrix();
    return () => {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    };
  }, [camera]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        // The first Esc only releases pointer lock (the browser does that itself).
        if (!document.pointerLockElement) useEditor.getState().stopWalk();
        return;
      }
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
      if (!p) return;
      p.yaw += dx * speed;
      p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p.pitch - dy * speed));
    };
    // A finger turns by the screen, not by the pixel: a swipe across the view is half a turn,
    // so a phone can look all round in two swipes, standing still.
    const touchSpeed = () => Math.PI / Math.max(200, el.clientWidth);
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
      look(e.clientX - drag.x, e.clientY - drag.y, drag.touch ? touchSpeed() : LOOK_SPEED);
      drag = { ...drag, x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      // A busy page can merge a quick swipe's moves into the lift: count its last stretch too.
      if (document.pointerLockElement !== el) {
        look(e.clientX - drag.x, e.clientY - drag.y, drag.touch ? touchSpeed() : LOOK_SPEED);
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
    if (!p) return;
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
    b.phase += (moved / STEP_LENGTH) * Math.PI;
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
