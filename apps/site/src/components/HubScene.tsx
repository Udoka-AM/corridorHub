import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * The network as a scene: Tempo is the hub, every region a spoke, and each
 * moving point a payment. Collections travel in, payouts travel out; one
 * spoke wears a ring for the shielded Zcash lane.
 */

const INK = new THREE.Color("#f4f4f0");
const SPOKES = 24;
const PAYMENTS = 120;

function spokePositions(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SPOKES; i++) {
    const y = 1 - (i / (SPOKES - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    const radius = 3.1 + ((i * 37) % 11) / 10; // deterministic variation, 3.1–4.1
    out.push(new THREE.Vector3(Math.cos(a) * r, y * 0.78, Math.sin(a) * r).multiplyScalar(radius));
  }
  return out;
}

function Network({ reduced }: { reduced: boolean }) {
  const group = useRef<THREE.Group>(null!);
  const hub = useRef<THREE.Group>(null!);
  const ringA = useRef<THREE.Mesh>(null!);
  const ringB = useRef<THREE.Mesh>(null!);
  const dots = useRef<THREE.InstancedMesh>(null!);
  const { size, pointer } = useThree();

  const spokes = useMemo(spokePositions, []);
  const curves = useMemo(
    () =>
      spokes.map((p) => {
        const start = p.clone().normalize().multiplyScalar(1.12);
        const mid = start.clone().add(p).multiplyScalar(0.5).multiplyScalar(1.22);
        return new THREE.QuadraticBezierCurve3(start, mid, p);
      }),
    [spokes],
  );
  const arcs = useMemo(
    () =>
      curves.map((c, i) => {
        const g = new THREE.BufferGeometry().setFromPoints(c.getPoints(56));
        const m = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: i === 5 ? 0.5 : 0.16 });
        return new THREE.Line(g, m);
      }),
    [curves],
  );
  const hubEdges = useMemo(() => new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.05, 1)), []);
  const stars = useMemo(() => {
    const pts = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(9 + Math.random() * 14);
      pts.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    return g;
  }, []);
  const payments = useMemo(
    () =>
      Array.from({ length: PAYMENTS }, (_, i) => ({
        arc: i % SPOKES,
        t: Math.random(),
        speed: 0.1 + Math.random() * 0.28,
        inbound: i % 3 === 0,
      })),
    [],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const at = useMemo(() => new THREE.Vector3(), []);

  const desktop = size.width > 900;

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    const g = group.current;
    if (!reduced) {
      g.rotation.y += d * 0.07;
      hub.current.rotation.y -= d * 0.25;
      hub.current.rotation.x += d * 0.12;
      ringA.current.rotation.z += d * 0.4;
      ringB.current.rotation.x += d * 0.3;
      const pulse = 1 + Math.sin(state.clock.elapsedTime * 1.6) * 0.035;
      hub.current.scale.setScalar(pulse);
    }
    g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, 0.18 + pointer.y * 0.22, 0.05);
    g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, -pointer.x * 0.1, 0.05);

    for (let i = 0; i < PAYMENTS; i++) {
      const p = payments[i]!;
      if (!reduced) {
        p.t += d * p.speed * (p.inbound ? -1 : 1);
        if (p.t > 1) p.t -= 1;
        if (p.t < 0) p.t += 1;
      }
      curves[p.arc]!.getPoint(p.t, at);
      dummy.position.copy(at);
      dummy.scale.setScalar(0.016 + 0.022 * Math.sin(p.t * Math.PI));
      dummy.updateMatrix();
      dots.current.setMatrixAt(i, dummy.matrix);
    }
    dots.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group ref={group} position={desktop ? [2.5, 0.1, 0] : [0, 1.4, -1.5]}>
      <points geometry={stars}>
        <pointsMaterial color={INK} size={0.02} sizeAttenuation transparent opacity={0.5} />
      </points>

      <group ref={hub}>
        <lineSegments geometry={hubEdges}>
          <lineBasicMaterial color={INK} transparent opacity={0.9} />
        </lineSegments>
        <mesh>
          <sphereGeometry args={[0.98, 32, 32]} />
          <meshBasicMaterial color="#050505" />
        </mesh>
      </group>
      <mesh ref={ringA} rotation={[Math.PI / 2.2, 0, 0]}>
        <torusGeometry args={[1.6, 0.006, 8, 160]} />
        <meshBasicMaterial color={INK} transparent opacity={0.6} />
      </mesh>
      <mesh ref={ringB} rotation={[0.3, Math.PI / 3, 0]}>
        <torusGeometry args={[2.05, 0.004, 8, 180]} />
        <meshBasicMaterial color={INK} transparent opacity={0.3} />
      </mesh>

      {arcs.map((line, i) => (
        <primitive key={i} object={line} />
      ))}
      {spokes.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[i % 4 === 0 ? 0.075 : 0.045, 12, 12]} />
          <meshBasicMaterial color={INK} />
        </mesh>
      ))}
      {/* the shielded spoke */}
      <mesh position={spokes[5]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.2, 0.008, 8, 64]} />
        <meshBasicMaterial color={INK} />
      </mesh>

      <instancedMesh ref={dots} args={[undefined, undefined, PAYMENTS]}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial color={INK} />
      </instancedMesh>
    </group>
  );
}

export default function HubScene({ active, reduced }: { active: boolean; reduced: boolean }) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      frameloop={!active ? "never" : reduced ? "demand" : "always"}
      camera={{ position: [0, 0, 10], fov: 40 }}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
      aria-hidden="true"
    >
      <color attach="background" args={["#050505"]} />
      <fog attach="fog" args={["#050505", 8, 19]} />
      <Network reduced={reduced} />
    </Canvas>
  );
}
