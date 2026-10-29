import { levelBounds } from '@dhd/core';
import { MaterialCache, buildLevel, disposeGroup } from '@dhd/render';
import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { useProject } from './store';

const materials = new MaterialCache();

function LevelMesh() {
  const level = useProject().levels[0];
  const group = useMemo(() => (level ? buildLevel(level, { materials }) : null), [level]);
  useEffect(() => () => void (group && disposeGroup(group)), [group]);
  return group ? <primitive object={group} /> : null;
}

export function Viewport() {
  const level = useProject().levels[0];
  // Centre the camera on the plan once per level, not on every edit.
  const levelId = level?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute only when the level changes
  const target = useMemo(() => {
    const b = level && levelBounds(level);
    return b ? { x: (b.min.x + b.max.x) / 2, z: (b.min.y + b.max.y) / 2 } : { x: 0, z: 0 };
  }, [levelId]);

  return (
    <Canvas
      shadows
      camera={{ position: [target.x + 8, 14, target.z + 12], fov: 45, near: 0.05, far: 500 }}
      data-testid="viewport"
    >
      <color attach="background" args={['#e9e6e1']} />
      <hemisphereLight args={['#ffffff', '#b8a98f', 0.9]} />
      <directionalLight
        position={[target.x + 10, 18, target.z - 6]}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
      />
      <mesh rotation-x={-Math.PI / 2} position={[target.x, -0.01, target.z]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#d6d1c8" />
      </mesh>
      <LevelMesh />
      <OrbitControls
        target={[target.x, 0, target.z]}
        makeDefault
        maxPolarAngle={Math.PI / 2 - 0.05}
        minDistance={2}
        maxDistance={60}
      />
    </Canvas>
  );
}
