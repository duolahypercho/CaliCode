import { homedir } from "node:os";
import path from "node:path";

import { WebContentsView, session, type BrowserWindow, type Rectangle } from "electron";
import type { PanelBounds } from "./ipc";

/**
 * Persistent so logins survive a restart, as they do in the agent's Chrome
 * profile today — but its own partition, because this view loads arbitrary
 * pages inside our app and their cookies must never reach the session the
 * editor and core RPC run on.
 */
const PARTITION = "persist:cali-browser";

/** A target only exists once there is a page, and core attaches at startup. */
const BLANK = "about:blank";

export interface BrowserPanel {
  setBounds(b: PanelBounds): void;
  targetId(): Promise<string | null>;
  destroy(): void;
}

/**
 * The BROWSER tab's page, as a real Chromium view rather than a video of one.
 *
 * The view is created here and driven by core over CDP — the same `browser.rs`
 * that drives Chrome today — so the user and the agent are never looking at two
 * different pages. Nothing about the protocol lives in this file; the main
 * process owns only the view's lifetime and its geometry.
 */
/**
 * Where a file downloaded in the panel lands.
 *
 * Under `~/.cali` beside core's own state rather than the OS Downloads folder,
 * because these are the agent's working material: the panel exists so a model
 * can go and find a `.glb` or a texture, and the next step is always to pull it
 * into a project. Somewhere core already knows how to look is worth more than
 * somewhere the user would expect to find a personal download.
 */
const DOWNLOAD_DIR = path.join(homedir(), ".cali", "downloads");

/**
 * Accept downloads instead of ignoring them.
 *
 * This capability is only possible now. A streamed panel had no file transfer
 * channel at all — clicking a download link did nothing, which for a browser
 * whose whole purpose is finding assets was a hole. A real view has a session,
 * and a session has downloads.
 *
 * Saved without prompting: a modal save dialog would be a native window over an
 * app that is already juggling a native view, and the destination is not the
 * user's choice here — it is a staging area the agent reads from.
 */
function captureDownloads(panelSession: Electron.Session): void {
  panelSession.on("will-download", (_event, item) => {
    const target = path.join(DOWNLOAD_DIR, path.basename(item.getFilename()));
    item.setSavePath(target);
    item.once("done", (_doneEvent, state) => {
      if (state === "completed") {
        console.log(`browser panel downloaded ${target}`);
      } else {
        console.error(`browser panel download failed (${state}): ${item.getFilename()}`);
      }
    });
  });
}

export function createBrowserPanel(win: BrowserWindow): BrowserPanel {
  const view = new WebContentsView({
    webPreferences: {
      session: session.fromPartition(PARTITION),
      // Untrusted pages. No preload and no Node reach, so nothing on the page
      // can address the main process even if it finds a bug in a renderer API.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  captureDownloads(view.webContents.session);

  let destroyed = false;
  let applied: Rectangle | null = null;
  let cachedTargetId: string | null = null;
  let inFlight: Promise<string | null> | null = null;

  // A popup would be a second CDP target, and core is attached to exactly one.
  // Keeping navigation in this view is what makes "one browser" true.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void view.webContents.loadURL(url);
    return { action: "deny" };
  });

  win.contentView.addChildView(view);
  // Starts hidden: until the renderer reports a rect, any bounds we invent
  // would paint over the editor.
  view.setVisible(false);
  void view.webContents.loadURL(BLANK).catch(() => {
    // Nothing to recover — core's first navigate replaces this anyway.
  });

  /**
   * Geometry arrives from the renderer in CSS pixels, which are the same
   * device-independent pixels Electron's view bounds use — do not scale by
   * devicePixelRatio. The rect is relative to the window's content area, and
   * that only matches the renderer's client coordinates while this is the sole
   * child view laid out over a full-bleed renderer.
   */
  const setBounds = (b: PanelBounds): void => {
    if (destroyed) return;

    // Hidden, never destroyed: the agent keeps browsing with the tab closed,
    // and a hidden view still captures and still takes trusted input. The
    // renderer also hides it while a Radix dropdown or dialog is open — a
    // native view composites above the DOM, so a portalled overlay would
    // otherwise be drawn behind it.
    if (!b.visible) {
      view.setVisible(false);
      return;
    }

    // Electron rejects fractional bounds; getBoundingClientRect returns them.
    const next: Rectangle = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(0, Math.round(b.width)),
      height: Math.max(0, Math.round(b.height)),
    };
    if (!applied || !sameRect(applied, next)) {
      // The panel's rounded corners and border are CSS and this view will not
      // clip to them; `view.setBorderRadius` is the fix if square corners
      // inside the frame ever read as wrong.
      view.setBounds(next);
      applied = next;
    }
    view.setVisible(true);
  };

  /**
   * Core attaches to this exact view instead of guessing from url or title.
   *
   * Only meaningful when the app was launched with `--remote-debugging-port`;
   * the id is the same one core sees in that port's target list. Stable for
   * the view's lifetime, so it is resolved once.
   */
  const targetId = async (): Promise<string | null> => {
    if (destroyed || view.webContents.isDestroyed()) return null;
    if (cachedTargetId) return cachedTargetId;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const wc = view.webContents;
      // `attach` throws when someone else holds the session — DevTools open on
      // this view, most likely. Borrow it only if it is free, and hand it back,
      // since holding it blocks DevTools for the rest of the run.
      const borrowed = !wc.debugger.isAttached();
      try {
        if (borrowed) wc.debugger.attach("1.3");
        const reply: unknown = await wc.debugger.sendCommand("Target.getTargetInfo");
        cachedTargetId = readTargetId(reply);
        return cachedTargetId;
      } catch {
        return null;
      } finally {
        if (borrowed && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    // `close` defaults to skipping beforeunload, so a page cannot refuse to go.
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };

  return { setBounds, targetId, destroy };
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function readTargetId(reply: unknown): string | null {
  if (typeof reply !== "object" || reply === null) return null;
  const info = (reply as { targetInfo?: unknown }).targetInfo;
  if (typeof info !== "object" || info === null) return null;
  const id = (info as { targetId?: unknown }).targetId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
