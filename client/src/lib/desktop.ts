/**
 * Desktop-shell detection.
 *
 * The same bundle is served three ways: to a plain browser on core's own
 * origin, to the Tauri webview, and to the Electron shell. Only the two
 * desktop shells draw native window controls over the top-left of the page,
 * so chrome that has to make room for them keys off this.
 *
 * Both shells are detected by a global they set, and neither sets the other's.
 * Missing the Electron case does not fail loudly — the app simply concludes it
 * is a browser tab, stops reserving space, and the macOS traffic lights land
 * on top of our own header.
 */

/**
 * What `client/electron/preload.ts` exposes. Declared structurally rather than
 * imported: `tsconfig.app.json` includes only `src`, so the shell's types are
 * outside this program, and a path mapping across that boundary would drag the
 * whole main-process program into the app build.
 */
interface ElectronBridge {
  shell: "electron";
  platform: string;
  chooseFolder(): Promise<string | null>;
  setPanelBounds(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
  }): void;
  panelTarget(): Promise<string | null>;
}

/** The Electron preload bridge, or null under Tauri or a plain browser. */
export function electronBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { cali?: ElectronBridge }).cali;
  return bridge?.shell === "electron" ? bridge : null;
}

/** True when running inside a desktop shell rather than a plain browser. */
export function isDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window || "__TAURI__" in window) return true;
  return electronBridge() !== null;
}

/** True on macOS, where the shell draws traffic lights over the page. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  return /mac/i.test(platform) || /mac os x/i.test(navigator.userAgent ?? "");
}

/** True only when native macOS traffic lights sit on top of our own header. */
export function hasOverlayWindowControls(): boolean {
  return isDesktopShell() && isMacPlatform();
}
