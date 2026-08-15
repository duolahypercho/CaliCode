/**
 * The whole main <-> renderer contract for the Electron shell.
 *
 * Deliberately free of Electron imports: the preload runs in a sandboxed
 * renderer context where importing `electron` pulls in main-process-only
 * modules, so this file has to stay pure types and constants to be shared by
 * both sides.
 */

export const IPC = {
  shellInfo: "cali:shell-info",
  chooseFolder: "cali:choose-folder",
  panelBounds: "cali:panel-bounds",
  panelTarget: "cali:panel-target",
} as const;

/**
 * Where the native browser panel sits, in CSS pixels relative to the window.
 * The renderer measures its own placeholder element and reports it; the panel
 * is a separate native view, so nothing keeps the two aligned but this message.
 */
export interface PanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface ShellInfo {
  shell: "electron";
  platform: NodeJS.Platform;
}

/**
 * What the preload puts on `window.cali`. `shell` and `platform` are plain
 * values rather than promises because layout decisions (macOS traffic lights
 * overlay our header) are made during the first render, before any round-trip
 * to the main process could resolve.
 */
export interface CaliBridge extends ShellInfo {
  chooseFolder(): Promise<string | null>;
  setPanelBounds(bounds: PanelBounds): void;
  panelTarget(): Promise<string | null>;
}
