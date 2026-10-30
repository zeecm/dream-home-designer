import { type Level, type Vec2, levelBounds } from '@dhd/core';
import { LevelMeshes, MaterialCache } from '@dhd/render';
import { OrbitControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from './editor';
import { useProject } from './store';
import { Joystick } from './walk/Joystick';
import { WalkControls } from './walk/WalkControls';

const materials = new MaterialCache();
const FOV = 40;

/**
 * Keeps one incremental mesh set per project; each edit rebuilds only what changed. Walking
 * puts the ceilings on (the orbit view leaves them off to see in).
 */
function LevelMesh({ ceilings }: { ceilings: boolean }) {
  const level = useProject().levels[0];
  const meshes = useMemo(() => new LevelMeshes(materials, { ceilings }), [ceilings]);
  useEffect(() => () => meshes.dispose(), [meshes]);
  useLayoutEffect(() => {
    if (level) meshes.update(level);
  }, [level, meshes]);
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

const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

export function Viewport() {
  const level = useProject().levels[0];
  const hasWalls = !!level && Object.keys(level.walls).length > 0;
  const hasRooms = !!level && Object.keys(level.rooms).length > 0;
  const dark = usePrefersDark();
  const walking = useEditor((s) => !!s.walking);
  const { startWalk, stopWalk } = useEditor.getState();
  const stick = useRef<Vec2>({ x: 0, y: 0 });
  // Frame the plan when the view mounts (once per project), not on every edit; the
  // parent remounts this component when another project opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame once walls exist, not on every edit
  const frame = useMemo(() => frameOf(level), [hasWalls]);

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
        <color attach="background" args={[dark ? '#0a0a0a' : '#f4f6f8']} />
        <hemisphereLight args={['#ffffff', dark ? '#3a3d40' : '#dfe3e6', walking ? 2.2 : 1.5]} />
        {/* Under the ceilings the sun can't reach; even light keeps rooms readable. */}
        {walking && <ambientLight intensity={0.6} />}
        <directionalLight
          castShadow={!walking}
          position={[frame.x + 8, 16, frame.z + 10]}
          intensity={1.8}
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0005}
          shadow-camera-left={-frame.radius * 1.5}
          shadow-camera-right={frame.radius * 1.5}
          shadow-camera-top={frame.radius * 1.5}
          shadow-camera-bottom={-frame.radius * 1.5}
        />
        <mesh rotation-x={-Math.PI / 2} position={[frame.x, -0.01, frame.z]} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color={dark ? '#1a1c1e' : '#eef1f3'} />
        </mesh>
        <LevelMesh ceilings={walking} />
        {walking && level ? (
          <WalkControls level={level} stick={stick} />
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
      {walking ? (
        <>
          <button type="button" className="btn viewport-action" onClick={stopWalk}>
            Leave walk
          </button>
          {coarsePointer() && <Joystick stick={stick} />}
          <p className="viewport-hint">
            {coarsePointer()
              ? 'Thumb stick to walk · drag to look'
              : 'W A S D or arrows to walk · Shift to run · click, then move the mouse to look · Esc to leave'}
          </p>
        </>
      ) : (
        <>
          {hasRooms && (
            <button type="button" className="btn viewport-action" onClick={startWalk}>
              Walk through
            </button>
          )}
          <p className="viewport-hint">Drag to orbit · right-drag to pan · scroll to zoom</p>
        </>
      )}
    </div>
  );
}
