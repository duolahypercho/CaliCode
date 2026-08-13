/**
 * Reads a design token off the document root so a WebGL scene can be painted
 * from the same palette as the DOM chrome around it.
 *
 * The fallback covers jsdom, where no stylesheet is attached and every token
 * resolves to the empty string.
 *
 * Not every 3D surface should follow the light/dark tokens: see the
 * `--viewport-*` block in index.css for the surfaces that deliberately do not.
 */
export function themeToken(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
