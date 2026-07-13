import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Unidades: 1 unidade = 1 mm (padrão de impressão 3D)
export class Viewport {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1318);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 20000);
    this.camera.position.set(150, 130, 170);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 4000;
    this.controls.maxPolarAngle = Math.PI * 0.55;
    this.controls.target.set(0, 15, 0);
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('start', () => { this._anim = null; });

    this._setupEnvironment();

    this._anim = null;
    this._frameCbs = [];
    this._clock = new THREE.Clock();

    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(container);
    this._resize();
  }

  _setupEnvironment() {
    const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x39424d, 1.5);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 2.3);
    dir.position.set(90, 160, 70);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    const s = 180;
    dir.shadow.camera.left = -s; dir.shadow.camera.right = s;
    dir.shadow.camera.top = s; dir.shadow.camera.bottom = -s;
    dir.shadow.camera.near = 10; dir.shadow.camera.far = 600;
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.6;
    this.scene.add(dir);
    this.sun = dir;

    const fill = new THREE.DirectionalLight(0x9db8d9, 0.6);
    fill.position.set(-80, 60, -90);
    this.scene.add(fill);

    // grade de 1 mm (fina) e 10 mm (forte), mesa de 300 mm
    this.scene.add(this._grid10 = new THREE.GridHelper(300, 30, 0x3d4b5e, 0x2b3644));
    this.scene.add(this._grid1 = new THREE.GridHelper(300, 300, 0x1b232e, 0x1b232e));
    this._grid1.position.y = -0.02;
    this._grid10.position.y = -0.01;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.ShadowMaterial({ opacity: 0.3 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.04;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // eixos discretos no origem (X vermelho, Z azul)
    const axes = new THREE.Group();
    const mkAxis = (to, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.05, 0), to]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
    };
    axes.add(mkAxis(new THREE.Vector3(60, 0.05, 0), 0xe06a5e));
    axes.add(mkAxis(new THREE.Vector3(0, 0.05, 60), 0x5b8fd9));
    this.scene.add(axes);
  }

  onFrame(cb) { this._frameCbs.push(cb); }

  start() {
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = this._clock.getDelta();
      if (this._anim) this._stepAnim();
      this.controls.update();
      for (const cb of this._frameCbs) cb(dt);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ---- navegação/câmera ----
  animateTo(pos, target, dur = 380) {
    this._anim = {
      t0: performance.now(), dur,
      fromPos: this.camera.position.clone(), toPos: pos.clone(),
      fromTgt: this.controls.target.clone(), toTgt: target.clone(),
    };
  }

  _stepAnim() {
    const a = this._anim;
    let t = (performance.now() - a.t0) / a.dur;
    if (t >= 1) { t = 1; this._anim = null; }
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.camera.position.lerpVectors(a.fromPos, a.toPos, e);
    this.controls.target.lerpVectors(a.fromTgt, a.toTgt, e);
  }

  setView(name, focusBox) {
    const box = focusBox && !focusBox.isEmpty() ? focusBox : null;
    const tgt = box ? box.getCenter(new THREE.Vector3()) : this.controls.target.clone();
    let dist = this.camera.position.distanceTo(this.controls.target);
    if (box) {
      const size = box.getSize(new THREE.Vector3()).length();
      dist = Math.max(size * 1.4, 60);
    }
    const dirs = {
      iso: new THREE.Vector3(1, 0.85, 1.15).normalize(),
      top: new THREE.Vector3(0, 1, 0.0001).normalize(),
      front: new THREE.Vector3(0, 0.12, 1).normalize(),
      right: new THREE.Vector3(1, 0.12, 0.0001).normalize(),
    };
    const d = dirs[name] || dirs.iso;
    this.animateTo(tgt.clone().addScaledVector(d, dist), tgt);
  }

  frameBox(box) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = Math.max(size * 1.35, 50);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(1, 0.8, 1).normalize();
    this.animateTo(center.clone().addScaledVector(dir, dist), center);
  }

  // ---- utilitários de picking ----
  pointerNDC(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  }

  raycastFrom(e, objects, recursive = true) {
    if (!this._ray) this._ray = new THREE.Raycaster();
    this._ray.setFromCamera(this.pointerNDC(e), this.camera);
    return this._ray.intersectObjects(objects, recursive);
  }

  raycastObject(e, object) {
    if (!this._ray) this._ray = new THREE.Raycaster();
    this._ray.setFromCamera(this.pointerNDC(e), this.camera);
    return this._ray.intersectObject(object, true);
  }

  planeHit(e, plane) {
    if (!this._ray) this._ray = new THREE.Raycaster();
    this._ray.setFromCamera(this.pointerNDC(e), this.camera);
    const out = new THREE.Vector3();
    return this._ray.ray.intersectPlane(plane, out) ? out : null;
  }
}
