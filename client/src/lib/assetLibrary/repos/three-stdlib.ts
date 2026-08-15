import type { AssetRepo } from "../types";

/**
 * three.js ships its `examples/jsm` helpers untranspiled and unversioned
 * against the core package. three-stdlib repackages the same modules as typed,
 * separately versioned ESM, so an agent can import `OrbitControls` or `GLTFLoader`
 * without reaching into a version-pinned deep path inside `three` itself.
 */
export const repo: AssetRepo = {
  id: "three-stdlib",
  name: "three-stdlib",
  url: "https://github.com/pmndrs/three-stdlib",
  category: "tooling",
  description:
    "Stand-alone, typed builds of the three.js example modules — camera controls, GLTF/FBX/DRACO loaders, postprocessing passes, geometry and math utilities — importable directly instead of through three/examples/jsm.",
  tags: ["three.js", "loaders", "controls", "postprocessing", "utilities"],
  license: "MIT",
  settings: [
    {
      key: "modules",
      label: "Preferred modules",
      type: "select",
      default: "all",
      options: ["all", "controls", "loaders", "postprocessing", "geometries"],
      description: "Narrows what the agent reaches for first when it needs a helper.",
    },
  ],
};
