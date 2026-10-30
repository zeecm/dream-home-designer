import { type Level, levelBounds } from '@dhd/core';
import { MaterialCache, buildLevel, disposeGroup } from '@dhd/render';
import { OrbitControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { useProject } from './store';

const materials = new MaterialCache();
const FOV = 40;

function LevelMesh() {
  const level = useProject().levels[0];
  const group = useMemo(() => (level ? buildLevel(level, { materials }) : null), [level]);
  useEffect(() => () => void (group && disposeGroup(group)), [group]);
  return group ? <primitive object={group} /> : null;
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

export function Viewport() {
  const level = useProject().levels[0];
  // Frame the plan when the view mounts (once per project), not on every edit; the
  // parent remounts this component when another project opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately computed once
  const frame = useMemo(() => frameOf(level), []);

  return (
    <div className="viewport" data-testid="viewport-wrap">
      <Canvas shadows camera={{ fov: FOV, near: 0.05, far: 500 }} data-testid="viewport">
        <color attach="background" args={['#f4f6f8']} />
        <hemisphereLight args={['#ffffff', '#dfe3e6', 1.5]} />
        <directionalLight
          position={[frame.x + 8, 16, frame.z + 10]}
          intensity={1.8}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0005}
          shadow-camera-left={-frame.radius * 1.5}
          shadow-camera-right={frame.radius * 1.5}
          shadow-camera-top={frame.radius * 1.5}
          shadow-camera-bottom={-frame.radius * 1.5}
        />
        <mesh rotation-x={-Math.PI / 2} position={[frame.x, -0.01, frame.z]} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color="#eef1f3" />
        </mesh>
        <LevelMesh />
        <CameraRig frame={frame} />
        <OrbitControls
          target={[frame.x, 0, frame.z]}
          makeDefault
          maxPolarAngle={Math.PI / 2 - 0.05}
          minDistance={2}
          maxDistance={80}
        />
      </Canvas>
    </div>
  );
}
