export interface ProjectTemplate {
  id: "blank" | "starter" | "showcase";
  name: string;
  description: string;
  contents: string;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "blank",
    name: "Blank scene",
    description: "Start from an empty scene and build every object yourself.",
    contents: "0 entities · No scripts",
  },
  {
    id: "starter",
    name: "Starter scene",
    description: "A lit floor, rotating hero cube, and two working scene tests.",
    contents: "3 entities · 2 tests",
  },
  {
    id: "showcase",
    name: "Showcase scene",
    description: "A turntable-ready subject, pedestal, lighting, and scene tests.",
    contents: "4 entities · 2 tests",
  },
];
