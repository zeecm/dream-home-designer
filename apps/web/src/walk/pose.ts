import { type Level, pointInPolygon, roomShapes } from '@dhd/core';
import type { WalkPose } from './WalkControls';

/**
 * Where this browser last stood in each project's walk, so the next walk picks up there.
 * A per-viewer convenience: kept in localStorage, and dropped if the spot is no longer
 * inside a room (the plan changed since).
 */
const KEY = 'dhd:walk:';

export function saveWalkPose(projectId: string, pose: WalkPose): void {
  try {
    window.localStorage.setItem(KEY + projectId, JSON.stringify(pose));
  } catch {
    // storage unavailable: the next walk starts at the plan's start point
  }
}

export function loadWalkPose(projectId: string, level: Level): WalkPose | null {
  try {
    const raw = window.localStorage.getItem(KEY + projectId);
    if (!raw) return null;
    const p = JSON.parse(raw) as WalkPose;
    const ok = [p.at?.x, p.at?.y, p.yaw, p.pitch].every((n) => Number.isFinite(n));
    if (!ok) return null;
    const inside = [...roomShapes(level).values()].some(
      (s) => pointInPolygon(p.at, s.outer) && !s.holes.some((h) => pointInPolygon(p.at, h)),
    );
    return inside ? p : null;
  } catch {
    return null;
  }
}
