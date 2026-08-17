import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";

/**
 * The isometric view.
 *
 * An orthographic camera is what makes this isometric rather than merely
 * angled: parallel lines stay parallel, so a tile is the same size wherever it
 * sits on screen. It also means the depth buffer does the occlusion work that a
 * hand-written 2D isometric renderer has to do with a topological sort — the
 * hardest part of that approach simply does not exist here.
 */

/**
 * Height of the visible world box, in world units. Width follows the aspect.
 *
 * Sized to frame a neighbourhood rather than the whole board: at a height that
 * fits all 40x40 tiles the buildings are a few pixels each and the thing reads
 * as an empty field. Zooming out to see everything is what `minZoom` is for.
 */
const FRUSTUM_HEIGHT = 30;

/**
 * True isometric: the camera sits on the (1,1,1) diagonal, which puts it
 * atan(sqrt 2) ~= 54.74 degrees off vertical. The polar angle is then locked,
 * because free orbit turns this into an ordinary 3D view and every alignment
 * the art relies on stops holding.
 */
const ISO_POLAR = Math.atan(Math.SQRT2);

export interface View {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  controls: MapControls;
  dispose(): void;
}

export function createView(canvas: HTMLCanvasElement): View {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Capped at 2: a 3x display gains nothing visible and costs 2.25x the pixels.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9e2ec);
  scene.fog = new THREE.Fog(0xd9e2ec, 120, 260);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  camera.position.set(70, 70, 70);
  camera.lookAt(0, 0, 0);

  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minPolarAngle = ISO_POLAR;
  controls.maxPolarAngle = ISO_POLAR;
  controls.minZoom = 0.35;
  controls.maxZoom = 4;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d9aa8, 2.1));

  const sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
  sun.position.set(48, 80, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // An orthographic shadow camera has to be sized by hand — the default box is
  // a couple of units across and the city would sit entirely outside it.
  const shadow = sun.shadow.camera;
  shadow.left = -90;
  shadow.right = 90;
  shadow.top = 90;
  shadow.bottom = -90;
  shadow.near = 1;
  shadow.far = 260;
  shadow.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const aspect = width / height;
    camera.top = FRUSTUM_HEIGHT / 2;
    camera.bottom = -FRUSTUM_HEIGHT / 2;
    camera.left = (-FRUSTUM_HEIGHT * aspect) / 2;
    camera.right = (FRUSTUM_HEIGHT * aspect) / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  resize();
  window.addEventListener("resize", resize);

  return {
    renderer,
    scene,
    camera,
    controls,
    dispose() {
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
    },
  };
}
