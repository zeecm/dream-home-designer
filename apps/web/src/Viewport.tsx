import {
  type Level,
  type Vec2,
  dayOfYear,
  daylight,
  itemLights,
  levelBounds,
  siteOf,
  sunDirection,
  sunPosition,
} from '@dhd/core';
import { LevelMeshes, MaterialCache, ModelLibrary } from '@dhd/render';
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  type MutableRefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { useEditor } from './editor';
import { registerScene3d } from './exports';
import { configureLoader, fetchUploaded } from './models';
import { useLevel, useProject } from './store';
import { Joystick } from './walk/Joystick';
import { MiniMap } from './walk/MiniMap';
import { WalkControls, type WalkPose } from './walk/WalkControls';
import { setSound, unlockAudio, useSound } from './walk/footsteps';
import { FOV_MIN, fittingFov, setWalkFov, useWalkAspect, useWalkFov, widestFov } from './walk/fov';
import { loadWalkPose, saveWalkPose } from './walk/pose';

const materials = new MaterialCache();
/** The furniture models, fetched once each for the session (Pages serves /models). */
const models = new ModelLibrary('/models/', fetchUploaded, configureLoader);
const FOV = 40;

/**
 * Keeps one incremental mesh set per project; each edit rebuilds only what changed. Walking
 * puts the ceilings on (the orbit view leaves them off to see in).
 */
function LevelMesh({
  ceilings,
  walker,
  of,
  group,
}: {
  ceilings: boolean;
  /** While walking, where the walker is: doors swing open as they come near. */
  walker?: MutableRefObject<WalkPose | null>;
  /** A level of its own to show (comparing before and after) instead of the one shown. */
  of?: Level;
  /** Handed the meshes' group, to show or hide it. */
  group?: MutableRefObject<THREE.Object3D | null>;
}) {
  const shown = useLevel();
  const level = of ?? shown;
  const meshes = useMemo(() => new LevelMeshes(materials, { ceilings, models }), [ceilings]);
  useDoorSwings(meshes, walker);
  useEffect(() => () => meshes.dispose(), [meshes]);
  useEffect(() => {
    if (!group) return;
    group.current = meshes.group;
    return () => {
      group.current = null;
    };
  }, [group, meshes]);
  // A model arriving swaps its stand-in box for it.
  const [arrived, setArrived] = useState(0);
  useEffect(() => models.onLoad(() => setArrived((n) => n + 1)), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `arrived` re-runs it for new models
  useLayoutEffect(() => {
    if (level) meshes.update(level);
  }, [level, meshes, arrived]);
  return <primitive object={meshes.group} />;
}

/** Within this of a door it opens; beyond DOOR_CLOSE it shuts (between, it stays as it is). */
const DOOR_OPEN = 2;
const DOOR_CLOSE = 2.8;
/** How fast a door swings: the fraction of the way per second. */
const DOOR_SPEED = 3;

/**
 * Inside doors stand open in the orbit view, as the plan draws them. Walking through, they
 * start shut, swing open as the walker comes near and shut again behind (at once with
 * reduced motion).
 */
function useDoorSwings(meshes: LevelMeshes, walker?: MutableRefObject<WalkPose | null>) {
  const open = useRef(new Map<string, number>());
  const want = useRef(new Map<string, number>());
  const instant = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    [],
  );
  // A walk starts with the doors shut (not swinging shut), and ends with them open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on starting or ending a walk
  useEffect(() => {
    open.current.clear();
    want.current.clear();
  }, [!!walker]);
  useFrame((_, dt) => {
    const at = walker?.current?.at;
    for (const d of meshes.doors()) {
      let target = 1;
      if (at) {
        const dist = Math.hypot(d.centre.x - at.x, d.centre.y - at.y);
        const was = want.current.get(d.id) ?? 0;
        target = dist < DOOR_OPEN ? 1 : dist > DOOR_CLOSE ? 0 : was;
      }
      want.current.set(d.id, target);
      const cur = open.current.get(d.id) ?? (at ? 0 : 1);
      const step = instant ? 1 : Math.min(dt, 0.1) * DOOR_SPEED;
      const next = cur + Math.max(-step, Math.min(step, target - cur));
      open.current.set(d.id, next);
      // Every frame: a door rebuilt by an edit starts standing open.
      meshes.setDoorOpen(d.id, next);
    }
  });
}

interface Frame {
  x: number;
  z: number;
  radius: number;
}

function frameOf(level: Level | undefined): Frame {
  const b = level && levelBounds(level);
  if (!b) return { x: 0, z: 0, radius: 6 };
  return {
    x: (b.min.x + b.max.x) / 2,
    z: (b.min.y + b.max.y) / 2,
    radius: Math.max(3, Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y) / 2),
  };
}

/** Frames the whole plan from above and to the front, for whatever shape the pane has. */
function CameraRig({ frame }: { frame: Frame }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const vertical = ((FOV / 2) * Math.PI) / 180;
    const horizontal = Math.atan(Math.tan(vertical) * aspect);
    const distance = (frame.radius * 1.15) / Math.sin(Math.min(vertical, horizontal));
    const dir = { x: 0.45, y: 0.78, z: 0.62 };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    camera.position.set(
      frame.x + (dir.x / len) * distance,
      (dir.y / len) * distance,
      frame.z + (dir.z / len) * distance,
    );
    camera.lookAt(frame.x, 0, frame.z);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height, frame]);
  return null;
}

function usePrefersDark() {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setDark(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return dark;
}

/** Lit lamps at once: each one costs every material a light in its shader. */
const MAX_LAMPS = 8;
/** Catalogue candela to this scene's light units (daylight here is about 2, not 10,000 lux). */
const LAMP_SCALE = 0.05;

/**
 * The lamps nearest the camera, up to MAX_LAMPS, re-chosen twice a second as it moves.
 * The number of lights changes only when lamps are added or removed, so shaders aren't
 * rebuilt as you walk.
 */
/** `max`: half each while comparing, so the two versions together stay in budget. */
function Lamps({ level, max = MAX_LAMPS }: { level: Level; max?: number }) {
  const lamps = useMemo(() => itemLights(level), [level]);
  const count = Math.min(max, lamps.length);
  const refs = useRef<(THREE.PointLight | null)[]>([]);
  const last = useRef(-1);
  const place = (camera: THREE.Camera) => {
    const nearest = [...lamps]
      .map((l) => ({
        l,
        d: camera.position.distanceToSquared(
          new THREE.Vector3(l.position.x, l.position.y, l.position.z),
        ),
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, max);
    nearest.forEach(({ l }, i) => {
      const light = refs.current[i];
      if (!light) return;
      light.position.set(l.position.x, l.position.y, l.position.z);
      light.color.set(l.color);
      light.intensity = l.candela * LAMP_SCALE;
      // How bright it is lit (comparing turns one version's lamps down for a while).
      light.userData.lit = light.intensity;
    });
  };
  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime;
    if (t - last.current < 0.5) return;
    last.current = t;
    place(camera);
  });
  // A lamp just added or moved shows at once, not on the next half-second.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on new lamps
  useEffect(() => {
    last.current = -1;
  }, [lamps]);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <pointLight
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool of lights
          key={i}
          ref={(l) => {
            refs.current[i] = l;
          }}
          decay={2}
          // Fades out by here, so a lamp doesn't light the whole block through walls.
          distance={7}
          intensity={0}
        />
      ))}
    </>
  );
}

const lerpColor = (a: string, b: string, t: number) =>
  `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;

/** 7.5 → "7:30 am". */
export function clockTime(h: number): string {
  const mins = Math.round(h * 60) % (24 * 60);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`;
}

/** The time of day the 3D view is lit for. */
function SunControl({ walking }: { walking: boolean }) {
  const hour = useEditor((s) => s.sunHour);
  const setHour = useEditor((s) => s.setSunHour);
  const wanted = useWalkFov();
  // A tall view (a phone held upright) can't show as wide a view: the slider stops there,
  // and says the angle it really shows.
  const aspect = useWalkAspect();
  const widest = widestFov(aspect);
  const fov = Math.min(wanted, widest);
  const shown = Math.round(Math.min(wanted, fittingFov(aspect)));
  return (
    <div className="sun-control">
      <label className="sun-control-row">
        <span className="sun-control-label">
          Time <span className="num">{clockTime(hour)}</span>
        </span>
        <input
          type="range"
          min={6}
          max={22}
          step={0.25}
          value={hour}
          aria-valuetext={clockTime(hour)}
          onChange={(e) => setHour(Number(e.target.value))}
        />
      </label>
      {/* While walking: how wide the eye sees, across (about 114° for people). */}
      {walking && (
        <label className="sun-control-row">
          <span className="sun-control-label">
            View <span className="num">{shown}°</span>
          </span>
          <input
            type="range"
            min={FOV_MIN}
            max={widest}
            step={5}
            value={fov}
            aria-label="Field of view"
            aria-valuetext={`${shown} degrees across`}
            onChange={(e) => {
              // At the end of the range a tall view allows, keep a wider choice made on a
              // wider screen.
              const v = Number(e.target.value);
              setWalkFov(v >= widest ? Math.max(v, wanted) : v);
            }}
          />
        </label>
      )}
    </div>
  );
}

/** Turns a group's lamps off, or back on as bright as `Lamps` lit them. */
function lampsOn(group: THREE.Object3D | null, on: boolean) {
  group?.traverse((o) => {
    if (o instanceof THREE.PointLight) o.intensity = on ? (o.userData.lit ?? 0) : 0;
  });
}

/** One version's meshes and lamps, as compared. */
interface Side {
  meshes: MutableRefObject<THREE.Object3D | null>;
  lamps: MutableRefObject<THREE.Object3D | null>;
}

/**
 * Comparing a renovation: the flat as it is left of the divider, the renovation right of it,
 * drawn in one view with one camera (each frame draws the scene twice, each time cut to its
 * side, with only that side's meshes and lamps). Lamps are dimmed rather than hidden, so the
 * number of lights (and the shaders built for it) stays the same. Outside the frame the
 * version shown above the plan is the one there (a download draws it).
 */
function CompareRender({
  split,
  before,
  after,
  shown,
}: {
  split: MutableRefObject<number>;
  before: Side;
  after: Side;
  shown: 'before' | 'after';
}) {
  useFrame(({ gl, scene, camera, size }) => {
    const b = before.meshes.current;
    const a = after.meshes.current;
    if (!b || !a) {
      gl.render(scene, camera);
      return;
    }
    const side = (on: Side, off: Side) => {
      if (on.meshes.current) on.meshes.current.visible = true;
      if (off.meshes.current) off.meshes.current.visible = false;
      lampsOn(on.lamps.current, true);
      lampsOn(off.lamps.current, false);
    };
    const x = Math.round(size.width * split.current);
    gl.setScissorTest(true);
    side(before, after);
    gl.setScissor(0, 0, x, size.height);
    gl.render(scene, camera);
    side(after, before);
    gl.setScissor(x, 0, size.width - x, size.height);
    gl.render(scene, camera);
    gl.setScissorTest(false);
    if (shown === 'before') side(before, after);
    // The version shown is the one a download finds by name.
    b.name = shown === 'before' ? 'level' : 'level-compared';
    a.name = shown === 'after' ? 'level' : 'level-compared';
  }, 1);
  return null;
}

/** How wide a side must be to show its label (px). */
const LABEL_ROOM = 90;

/** The divider between before and after, dragged (or moved with the arrow keys) across. */
function CompareDivider({
  split,
  onChange,
}: {
  split: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(0.95, Math.max(0.05, v));
  const self = useRef<HTMLDivElement>(null);
  // A label shows only where its side is wide enough to hold it.
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const view = self.current?.parentElement;
    if (!view) return;
    const watch = new ResizeObserver(() => setWidth(view.clientWidth));
    watch.observe(view);
    setWidth(view.clientWidth);
    return () => watch.disconnect();
  }, []);
  const keys: Record<string, number> = {
    ArrowLeft: split - 0.05,
    ArrowRight: split + 0.05,
    PageDown: split - 0.25,
    PageUp: split + 0.25,
    Home: 0,
    End: 1,
  };
  return (
    <div ref={self} className="compare-divider" style={{ left: `${split * 100}%` }}>
      {width * split >= LABEL_ROOM && (
        <span className="compare-label compare-label-before">Before</span>
      )}
      {width * (1 - split) >= LABEL_ROOM && (
        <span className="compare-label compare-label-after">After</span>
      )}
      <div
        className="compare-handle"
        role="slider"
        tabIndex={0}
        aria-label="Divider between before and after"
        aria-valuemin={5}
        aria-valuemax={95}
        aria-valuenow={Math.round(split * 100)}
        aria-valuetext={`${Math.round(split * 100)}% before`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.stopPropagation();
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.stopPropagation();
            const view = self.current?.parentElement;
            if (!view) return;
            const r = view.getBoundingClientRect();
            onChange(clamp((e.clientX - r.left) / r.width));
          }
        }}
        onKeyDown={(e) => {
          const to = keys[e.key];
          if (to === undefined) return;
          e.preventDefault();
          onChange(clamp(to));
        }}
      />
    </div>
  );
}

/** Lets the downloads draw this view on demand and reach the level's meshes. */
function Capture() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    registerScene3d({
      render: () => gl.render(scene, camera),
      canvas: gl.domElement,
      level: () => scene.getObjectByName('level'),
    });
    return () => registerScene3d(null);
  }, [gl, scene, camera]);
  return null;
}

const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

export function Viewport() {
  const project = useProject();
  const level = useLevel();
  const hasWalls = !!level && Object.keys(level.walls).length > 0;
  const hasRooms = !!level && Object.keys(level.rooms).length > 0;
  const dark = usePrefersDark();
  const walking = useEditor((s) => !!s.walking);
  const { startWalk, stopWalk } = useEditor.getState();
  // Comparing a renovation's before and after, side by side across a divider.
  const [comparing, setComparing] = useState(false);
  const [split, setSplit] = useState(0.5);
  const splitRef = useRef(0.5);
  splitRef.current = split;
  const beforeGroup = useRef<THREE.Object3D | null>(null);
  const afterGroup = useRef<THREE.Object3D | null>(null);
  const beforeLamps = useRef<THREE.Group | null>(null);
  const afterLamps = useRef<THREE.Group | null>(null);
  const variant = useEditor((s) => s.variant);
  // A renovation ended (made the plan, discarded): nothing left to compare.
  const renovating = !!project.renovation;
  useEffect(() => {
    if (!renovating) setComparing(false);
  }, [renovating]);
  const versions = project.renovation
    ? { before: project.levels[0], after: project.renovation.levels[0] }
    : null;
  const compare = comparing && !walking && !!versions?.before && !!versions.after;
  const stick = useRef<Vec2>({ x: 0, y: 0 });
  const projectId = project.id;
  const pose = useRef<WalkPose | null>(null);
  // Leaving a walk forgets the pose here (WalkControls hands it to saveWalkPose as it goes).
  useEffect(() => {
    if (!walking) {
      pose.current = null;
      stick.current = { x: 0, y: 0 }; // a thumb still on the stick when the walk ended
    }
  }, [walking]);
  // Frame the plan when the view mounts (once per project), not on every edit; the
  // parent remounts this component when another project opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame once walls exist, not on every edit
  const frame = useMemo(() => frameOf(level), [hasWalls]);
  const site = siteOf(project);
  const hour = useEditor((s) => s.sunHour);
  const day = useMemo(() => dayOfYear(new Date()), []);
  const sun = sunPosition(site, day, hour);
  const dir = sunDirection(site, sun);
  const light = daylight(sun);
  const reach = frame.radius * 3;
  const sunTarget = useMemo(() => new THREE.Object3D(), []);
  // Low sun is warm; night is a dim blue sky with the lamps doing the work.
  const sunColor = lerpColor('#ffb066', '#fff6ea', Math.min(1, Math.max(0, sun.altitude / 25)));
  const sky = lerpColor('#3a4a6b', '#ffffff', light);
  const background = dark
    ? lerpColor('#05070b', '#0a0a0a', light)
    : lerpColor('#1b2230', '#f4f6f8', light);

  if (!hasWalls) {
    return (
      <div className="viewport viewport-empty" data-testid="viewport-wrap">
        <p>The 3D view appears as soon as you draw a wall.</p>
      </div>
    );
  }

  return (
    <div className="viewport" data-testid="viewport-wrap">
      <Canvas shadows camera={{ fov: FOV, near: 0.05, far: 500 }} data-testid="viewport">
        <color attach="background" args={[background]} />
        <hemisphereLight
          args={[
            sky,
            dark ? '#3a3d40' : '#dfe3e6',
            // Indoors at night only the lamps should really light a room.
            walking ? 0.05 + 2.15 * light : 0.3 + 1.2 * light,
          ]}
        />
        {/* Under the ceilings the sun can't reach; even light keeps rooms readable. */}
        {walking && <ambientLight intensity={0.02 + 0.33 * light} />}
        <primitive object={sunTarget} position={[frame.x, 0, frame.z]} />
        <directionalLight
          castShadow={!walking && sun.altitude > 0}
          target={sunTarget}
          position={[frame.x + dir.x * reach, Math.max(0, dir.y) * reach, frame.z + dir.z * reach]}
          color={sunColor}
          intensity={sun.altitude > 0 ? 2 * light : 0}
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0005}
          shadow-camera-left={-frame.radius * 1.5}
          shadow-camera-right={frame.radius * 1.5}
          shadow-camera-top={frame.radius * 1.5}
          shadow-camera-bottom={-frame.radius * 1.5}
          shadow-camera-far={reach * 2.5}
        />
        {compare && versions?.before && versions.after ? (
          <>
            <group ref={beforeLamps}>
              <Lamps level={versions.before} max={MAX_LAMPS / 2} />
            </group>
            <group ref={afterLamps}>
              <Lamps level={versions.after} max={MAX_LAMPS / 2} />
            </group>
          </>
        ) : (
          level && <Lamps level={level} />
        )}
        <Capture />
        <mesh rotation-x={-Math.PI / 2} position={[frame.x, -0.01, frame.z]} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color={dark ? '#1a1c1e' : '#eef1f3'} />
        </mesh>
        {compare && versions?.before && versions.after ? (
          <>
            <LevelMesh ceilings={false} of={versions.before} group={beforeGroup} />
            <LevelMesh ceilings={false} of={versions.after} group={afterGroup} />
            <CompareRender
              split={splitRef}
              before={{ meshes: beforeGroup, lamps: beforeLamps }}
              after={{ meshes: afterGroup, lamps: afterLamps }}
              shown={variant}
            />
          </>
        ) : (
          <LevelMesh ceilings={walking} walker={walking ? pose : undefined} />
        )}
        {walking && level ? (
          <WalkControls
            level={level}
            stick={stick}
            pose={pose}
            initial={() => loadWalkPose(projectId, level)}
            onLeave={(p) => saveWalkPose(projectId, p)}
          />
        ) : (
          <>
            <CameraRig frame={frame} />
            <OrbitControls
              target={[frame.x, 0, frame.z]}
              makeDefault
              // Panning glides over the floor (as a map does), not up and down the screen.
              screenSpacePanning={false}
              maxPolarAngle={Math.PI / 2 - 0.05}
              minDistance={2}
              maxDistance={80}
            />
          </>
        )}
      </Canvas>
      <SunControl walking={walking} />
      {walking ? (
        <>
          <button type="button" className="btn viewport-action" onClick={stopWalk}>
            Leave walk
          </button>
          <SoundToggle />
          {level && <MiniMap level={level} pose={pose} />}
          {coarsePointer() && <Joystick stick={stick} />}
          <p className="viewport-hint">
            {coarsePointer()
              ? 'Thumb stick to walk · drag to look'
              : 'W A S D or arrows to walk · Shift to run · click to look with the mouse · Esc frees the mouse, Esc again leaves'}
          </p>
        </>
      ) : (
        <>
          {/* First, so the view's controls stay on top of it. */}
          {compare && <CompareDivider split={split} onChange={setSplit} />}
          {hasRooms && (
            <button
              type="button"
              className="btn viewport-action"
              onClick={() => {
                unlockAudio();
                startWalk();
              }}
            >
              Walk through
            </button>
          )}
          {versions && (
            <button
              type="button"
              className="btn viewport-compare"
              aria-pressed={compare}
              onClick={() => setComparing(!compare)}
            >
              {compare ? 'Stop comparing' : 'Compare before and after'}
            </button>
          )}
          <p className="viewport-hint">
            {coarsePointer()
              ? 'Drag to orbit · pinch to zoom · two fingers to pan'
              : 'Drag to orbit · right-drag to pan · scroll to zoom'}
          </p>
        </>
      )}
    </div>
  );
}

/** Footsteps on or off while walking (remembered in this browser). */
function SoundToggle() {
  const sound = useSound();
  return (
    <button
      type="button"
      className="btn viewport-sound"
      aria-pressed={sound}
      onClick={() => {
        setSound(!sound);
        unlockAudio();
      }}
    >
      {sound ? 'Footsteps on' : 'Footsteps off'}
    </button>
  );
}
