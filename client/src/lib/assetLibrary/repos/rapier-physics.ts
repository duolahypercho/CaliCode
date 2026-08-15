import type { AssetRepo } from "../types";

/**
 * The physics engine itself, not a binding. Chosen over `use-cannon` and
 * `react-three-rapier` because both of those are React-Three-Fiber hook
 * packages with no non-R3F entry point, and this editor drives raw three.js.
 * `@dimforge/rapier3d-compat` is plain WASM: it steps a world and hands back
 * transforms, which the caller copies onto `Object3D`s however it likes.
 */
export const repo: AssetRepo = {
  id: "rapier-physics",
  name: "Rapier Physics",
  url: "https://github.com/dimforge/rapier",
  category: "tooling",
  description:
    "Rigid-body and collision physics as a standalone WASM engine — rigid bodies, colliders, joints, character controllers and raycasts. Framework-agnostic, so it drives plain three.js meshes without pulling in React.",
  tags: ["physics", "three.js", "wasm", "collision", "rigidbody"],
  license: "Apache-2.0",
  settings: [
    {
      key: "gravityY",
      label: "Gravity",
      type: "number",
      default: -9.81,
      min: -50,
      max: 50,
      step: 0.01,
      description: "Vertical acceleration in units/s². Zero gives a space-sim feel.",
    },
    {
      key: "timestepHz",
      label: "Simulation rate",
      type: "number",
      default: 60,
      min: 30,
      max: 240,
      step: 10,
      description: "Fixed physics steps per second, decoupled from render framerate.",
    },
    {
      key: "solverIterations",
      label: "Solver iterations",
      type: "number",
      default: 4,
      min: 1,
      max: 16,
      step: 1,
      description: "Higher values stiffen stacks and joints at proportional CPU cost.",
    },
    {
      key: "ccd",
      label: "Continuous collision",
      type: "boolean",
      default: false,
      description: "Stops fast bodies tunnelling through thin geometry. Costs a broadphase pass.",
    },
    {
      key: "debugRender",
      label: "Debug wireframes",
      type: "boolean",
      default: false,
      description: "Draw collider outlines over the scene to check shapes match the visual mesh.",
    },
  ],
};
