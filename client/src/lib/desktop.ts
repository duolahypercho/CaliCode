/**
 * Desktop-shell detection.
 *
 * The same bundle is served to a plain browser (core's own origin) and to the
 * Tauri webview. Only the Tauri case has native window controls overlaying the
 * top-left of the page, so chrome that has to make room for them keys off this.
 */

/** True when running inside the Tauri webview rather than a plain browser. */
export function isDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
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
