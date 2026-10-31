// Development only: draws each catalogue piece as the 3D view does, three-quarters from the
// front, on a transparent square, and leaves them on window.thumbs for the thumbnail script.
import { FURNITURE, emptyLevel, newItem } from '@dhd/core';
import { LevelMeshes, MaterialCache, ModelLibrary } from '@dhd/render';
import * as THREE from 'three';

const SIZE = 192;

declare global {
  interface Window {
    thumbs?: Record<string, string>;
  }
}

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setClearColor(0x000000, 0);
  document.body.append(renderer.domElement);
  const materials = new MaterialCache();
  const models = new ModelLibrary('/models/');
  const out: Record<string, string> = {};
  for (const kind of FURNITURE) {
    const level = emptyLevel();
    const item = newItem('thumb', kind, { x: 0, y: 0 });
    // On the floor, whatever its usual height: a ceiling fan is drawn standing, not hanging.
    item.position.y = 0;
    level.items[item.id] = item;
    const meshes = new LevelMeshes(materials, { models });
    meshes.update(level);
    if (kind.model) {
      while (!models.has(kind.model)) await new Promise((r) => setTimeout(r, 50));
      meshes.update(level);
    }
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#b8b4ac', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(2, 4, 3);
    scene.add(sun, meshes.group);
    const box = new THREE.Box3().setFromObject(meshes.group);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    const dir = new THREE.Vector3(0.55, 0.5, 1).normalize();
    camera.position.copy(centre).addScaledVector(dir, radius / Math.sin((15 * Math.PI) / 180));
    camera.lookAt(centre);
    renderer.render(scene, camera);
    out[kind.id] = renderer.domElement.toDataURL('image/png');
    meshes.dispose();
  }
  window.thumbs = out;
}

void main();
