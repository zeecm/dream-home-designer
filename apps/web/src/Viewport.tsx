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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useEditor } from './editor';
import { registerScene3d } from './exports';
import { fetchUploaded } from './models';
import { useLevel, useProject } from './store';
import { Joystick } from './walk/Joystick';
import { MiniMap } from './walk/MiniMap';
import { WalkControls, type WalkPose } from './walk/WalkControls';
import { loadWalkPose, saveWalkPose } from './walk/pose';

const materials = new MaterialCache();
/** The furniture models, fetched once each for the session (Pages serves /models). */
const models = new ModelLibrary('/models/', fetchUploaded);
const FOV = 40;

/**
 * Keeps one incremental mesh set per project; each edit rebuilds only what changed. Walking
 * puts the ceilings on (the orbit view leaves them off to see in).
 */
function LevelMesh({ ceilings }: { ceilings: boolean }) {
  const level = useLevel();
  const meshes = useMemo(() => new LevelMeshes(materials, { ceilings, models }), [ceilings]);
  useEffect(() => () => meshes.dispose(), [meshes]);
  // A model arriving swaps its stand-in box for it.
  const [arrived, setArrived] = useState(0);
  useEffect(() => models.onLoad(() => setArrived((n) => n + 1)), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `arrived` re-runs it for new models
  useLayoutEffect(() => {
    if (level) meshes.update(level);
  }, [level, meshes, arrived]);
  return <primitive object={meshes.group} />;
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
function Lamps({ level }: { level: Level }) {
  const lamps = useMemo(() => itemLights(level), [level]);
  const count = Math.min(MAX_LAMPS, lamps.length);
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
      .slice(0, MAX_LAMPS);
    nearest.forEach(({ l }, i) => {
      const light = refs.current[i];
      if (!light) return;
      light.position.set(l.position.x, l.position.y, l.position.z);
      light.color.set(l.color);
      light.intensity = l.candela * LAMP_SCALE;
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
function SunControl() {
  const hour = useEditor((s) => s.sunHour);
  const setHour = useEditor((s) => s.setSunHour);
  return (
    <label className="sun-control">
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
        {level && <Lamps level={level} />}
        <Capture />
        <mesh rotation-x={-Math.PI / 2} position={[frame.x, -0.01, frame.z]} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color={dark ? '#1a1c1e' : '#eef1f3'} />
        </mesh>
        <LevelMesh ceilings={walking} />
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
              maxPolarAngle={Math.PI / 2 - 0.05}
              minDistance={2}
              maxDistance={80}
            />
          </>
        )}
      </Canvas>
      <SunControl />
      {walking ? (
        <>
          <button type="button" className="btn viewport-action" onClick={stopWalk}>
            Leave walk
          </button>
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
          {hasRooms && (
            <button type="button" className="btn viewport-action" onClick={startWalk}>
              Walk through
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
