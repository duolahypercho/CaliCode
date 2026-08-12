import type { AssetRepo } from "../types";

/**
 * Three.js ability-casting VFX reference: linear projectile abilities with
 * charge-up, travel trail, and impact stages.
 */
export const repo: AssetRepo = {
  id: "linear-ability-casting",
  name: "Linear Ability Casting",
  url: "https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS",
  category: "vfx",
  description:
    "Linear ability-casting VFX for three.js — projectile trails with charge-up and impact stages, usable as the studio's reference for character ability effects.",
  tags: ["vfx", "three.js", "abilities", "particles"],
  license: "MIT",
  settings: [
    {
      key: "trailColor",
      label: "Trail color",
      type: "string",
      default: "#7dd3fc",
      description: "Hex color of the projectile trail.",
    },
    {
      key: "projectileSpeed",
      label: "Projectile speed",
      type: "number",
      default: 18,
      min: 1,
      max: 60,
      step: 1,
      description: "Units per second the ability projectile travels.",
    },
    {
      key: "impactGlow",
      label: "Impact glow",
      type: "boolean",
      default: true,
      description: "Spawn a glow burst where the projectile lands.",
    },
  ],
};
