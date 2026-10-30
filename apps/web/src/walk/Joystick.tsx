import { useEffect, useRef, useState } from 'react';
import type { StickInput } from './WalkControls';

const RADIUS = 48;

/** A thumb stick for walking on touch screens: drag the knob; release to stop. */
export function Joystick({ stick }: { stick: StickInput }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const active = useRef<number | null>(null);
  // Leaving mid-gesture never delivers the pointerup: let go of the stick on the way out.
  useEffect(
    () => () => {
      stick.current = { x: 0, y: 0 };
    },
    [stick],
  );

  const update = (e: React.PointerEvent) => {
    const b = base.current?.getBoundingClientRect();
    if (!b) return;
    let dx = e.clientX - (b.left + b.width / 2);
    let dy = e.clientY - (b.top + b.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > RADIUS) {
      dx = (dx / d) * RADIUS;
      dy = (dy / d) * RADIUS;
    }
    setKnob({ x: dx, y: dy });
    stick.current = { x: dx / RADIUS, y: -dy / RADIUS };
  };
  const stop = () => {
    active.current = null;
    setKnob({ x: 0, y: 0 });
    stick.current = { x: 0, y: 0 };
  };

  return (
    <div
      ref={base}
      className="joystick"
      role="presentation"
      onPointerDown={(e) => {
        active.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => {
        if (active.current === e.pointerId) update(e);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}
