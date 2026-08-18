/**
 * CaliCode desktop shell (Electron).
 *
 * The web editor is served in full by the Rust core: `/rpc`, `/events`, and the
 * built client all live at core's own origin. Packaged builds launch the bundled
 * `cali-core`; dev runs attach to the live core started by `scripts/dev.sh`. In
 * both cases the window points at `http://127.0.0.1:8765` once core answers.
 * Everything the renderer does is same-origin — no CORS, no proxy, no change to
 * the client's `fetch("/rpc")` / `EventSource("/events")`.
 *
 * The only shell. It replaced a Tauri one, whose webview could not host the
 * browser panel as anything better than a video stream
 * (docs/plans/electron-shell.md).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";

import { createBrowserPanel, type BrowserPanel } from "./browserPanel";
import { IPC, type PanelBounds, type ShellInfo } from "./ipc";

/**
 * Names the userData directory (`~/Library/Application Support/CaliCode`) and
 * `app.getName()`. Electron would otherwise take `package.json`'s `name` —
 * `client` — and scatter this app's cookies and cache under that.
 *
 * It does *not* rename the macOS menu bar in an unpackaged run: that title comes
 * from the running bundle's `CFBundleName`, which is Electron's own, so
 * `pnpm desktop:electron` shows "Electron" no matter what this says. Only a
 * packaged build says CaliCode there, because electron-builder writes the plist.
 *
 * Must run before the first `getPath("userData")`, which is why it is at module
 * scope rather than inside `whenReady`.
 */
app.setName("CaliCode");

/**
 * Port core listens on. Overridable so a second instance can run beside a live app instead of
 * fighting it for the port. `vite.config.ts` already honours the same variable
 * for the same reason — and attaching a second client to someone else's core
 * does worse than collide: `editor_attachment` is one owner per session, so the
 * newcomer silently steals tool routing from the window already working.
 */
const CORE_PORT = Number(process.env.CALI_PORT ?? 8765);
const CORE_ORIGIN = `http://127.0.0.1:${CORE_PORT}`;

/**
 * Load-bearing, not a debugging aid: `browser.rs` attaches over the devtools
 * protocol on this port and drives the panel's `WebContentsView` as a CDP target,
 * which is the whole reason the browser panel can stop being a video stream.
 * Chromium reads its switches at process start, so this must run before ready.
 */
const REMOTE_DEBUGGING_PORT = 9222;
app.commandLine.appendSwitch("remote-debugging-port", String(REMOTE_DEBUGGING_PORT));

/** "starting" is the only state that can still reach readiness; the rest are terminal. */
type CoreStartup = "starting" | "port-busy" | "spawn-failed" | "live-core-unavailable";

/** Shown in the window when startup never reaches readiness. */
const STARTUP_MESSAGES: Record<CoreStartup, string> = {
  "port-busy":
    "CaliCode could not start its core because port 8765 is already in use. Quit the other CaliCode/browser core or use a separate dev port.",
  "spawn-failed":
    "CaliCode could not launch its bundled core. Rebuild the desktop app and try again.",
  starting:
    "CaliCode core did not become ready on port 8765. Check the app logs and try again.",
  "live-core-unavailable":
    "Desktop development mode expects a live core on port 8765. Run ./scripts/dev.sh first, then relaunch the desktop shell.",
};

let core: ChildProcess | null = null;
let coreExited = false;

/**
 * Resolve the `cali-core` binary. Packaged: staged next to the app's resources.
 * Dev: the release build in the source tree.
 *
 * The packaged layout is not settled — P4 owns electron-builder — so both the
 * `extraResources` root and an `app.asar.unpacked` sibling are probed rather than
 * committing to one that a later packaging change would silently invalidate.
 */
function resolveCoreBinary(): string {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "cali-core"),
        path.join(process.resourcesPath, "bin", "cali-core"),
        path.join(path.dirname(app.getPath("exe")), "cali-core"),
      ]
    : [
        path.join(repoRoot(), "core", "target", "release", "cali-core"),
        path.join(repoRoot(), "core", "target", "debug", "cali-core"),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Repo root from the compiled main. Where tsc/the bundler drops this file is
 * P4's call, so walk up for the marker rather than hard-coding a depth.
 */
function repoRoot(): string {
  let dir = __dirname;
  for (let up = 0; up < 5; up += 1) {
    if (existsSync(path.join(dir, "core", "Cargo.toml"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, "..", "..");
}

/**
 * Resolve the built client `dist` that core serves. A staged copy from the last
 * desktop build is intentionally ignored outside a packaged app; otherwise a
 * stale bundle can mask web changes.
 */
function resolveDist(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "dist")]
    : [path.join(repoRoot(), "client", "dist")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Spawn the core JSON-RPC service. `CALI_DIST` makes core serve the built client
 * from the resolved path regardless of the child's working directory.
 */
function spawnCore(binary: string, dist: string | null): ChildProcess | null {
  // Annotated rather than inferred: the object literal would otherwise be typed
  // by its initial keys alone, and adding `CALI_DIST` below would not compile.
  const env: NodeJS.ProcessEnv = { ...process.env, CALI_PORT: String(CORE_PORT) };
  if (dist) {
    env.CALI_DIST = dist;
  }
  try {
    const child = spawn(binary, [], { env, stdio: "inherit" });
    child.once("exit", () => {
      coreExited = true;
    });
    // `spawn` reports a missing or non-executable binary asynchronously; without
    // this the readiness poll would run its full deadline against nothing.
    child.once("error", (err) => {
      coreExited = true;
      console.error(`failed to spawn cali-core at ${binary}: ${err.message}`);
    });
    return child;
  } catch (err) {
    console.error(`failed to spawn cali-core at ${binary}: ${String(err)}`);
    return null;
  }
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(150, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * A TCP connect only proves *something* holds the port. Asking `/health` proves
 * it is core and that it is routing, which is what the window is about to depend
 * on.
 */
function healthOk(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    // A destroyed request does not reliably emit `error`, and an unresolved
    // promise here would stall the readiness loop forever rather than time out.
    const settle = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const req = request(
      { host: "127.0.0.1", port: CORE_PORT, path: "/health", timeout: 300 },
      (res) => {
        res.resume();
        settle(res.statusCode === 200);
      },
    );
    req.once("timeout", () => {
      req.destroy();
      settle(false);
    });
    req.once("error", () => settle(false));
    req.end();
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until core answers or the deadline passes. */
async function waitForCore(attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A preflight port check cannot eliminate a race where another process binds
    // the port between the check and our spawn. Observe the child too, so
    // readiness never attaches the window to that other process.
    if (core && coreExited) {
      return false;
    }
    if (await healthOk()) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function startCore(): Promise<CoreStartup> {
  if (!app.isPackaged) {
    // A dev shell deliberately attaches to the live core from scripts/dev.sh and
    // must not spawn a second one to fight it for 8765.
    if (await portIsOpen(CORE_PORT)) {
      return "starting";
    }
    console.error(`desktop dev shell requires a live core on port ${CORE_PORT}`);
    return "live-core-unavailable";
  }
  if (await portIsOpen(CORE_PORT)) {
    console.error(
      `core port ${CORE_PORT} is already in use; refusing to attach the desktop window`,
    );
    return "port-busy";
  }
  core = spawnCore(resolveCoreBinary(), resolveDist());
  return core ? "starting" : "spawn-failed";
}

/** Kill core so no orphan server lingers holding :8765 against the next launch. */
function stopCore(): void {
  if (!core) {
    return;
  }
  const child = core;
  core = null;
  child.kill();
}

/**
 * The brand mark, for the places macOS does not take from the bundle: the dock
 * and taskbar while running unpackaged. A packaged build gets its icon from
 * `build-electron/icon.icns` via electron-builder, and this returns nothing
 * because the staged resources do not carry the source png.
 */
function brandIcon() {
  const png = path.join(__dirname, "..", "build-electron", "icon.png");
  if (!existsSync(png)) return undefined;
  const image = nativeImage.createFromPath(png);
  return image.isEmpty() ? undefined : image;
}

function createWindow(): BrowserWindow {
  const icon = brandIcon();
  return new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    center: true,
    show: false,
    title: "CaliCode",
    ...(icon ? { icon } : {}),
    titleBarStyle: "hiddenInset",
    // Measured, not inherited: this is the top-left of the traffic-light group,
    // and Electron places it ~6.75pt above the buttons' visual centre. The
    // sidebar's window-controls row is `h-10` with no top padding, so its icons
    // centre at 20pt — putting the lights on that same line means y = 20 - 6.75.
    // The Tauri shell's 23 sat them a full 10pt low, on their own line.
    trafficLightPosition: { x: 16, y: 13 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Left ON. A sandboxed preload cannot `require` a local module, and this
      // one imports `./ipc` for the channel names — which failed *silently*,
      // leaving `window.cali` undefined and the app concluding it was a browser
      // tab. P1 bought time with `sandbox: false`; the real fix is that the
      // build now bundles the preload into a single file with no local requires
      // (see `build:electron`), so the sandbox costs nothing.
      sandbox: true,
      // Sibling of this file in the compiled output, which is CommonJS — a
      // preload cannot be an ES module.
      preload: path.join(__dirname, "preload.js"),
    },
  });
}

/**
 * Core never came up. Surface a plain message instead of a blank window so the
 * failure is visible and actionable.
 */
async function showFailure(win: BrowserWindow, startup: CoreStartup) {
  const message = STARTUP_MESSAGES[startup];
  const body = `<div style="font:16px system-ui;color:#e2e8f0;background:#0f172a;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem">${message}</div>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`);
}

function registerIpc(panel: BrowserPanel): void {
  ipcMain.handle(
    IPC.shellInfo,
    (): ShellInfo => ({ shell: "electron", platform: process.platform }),
  );
  ipcMain.handle(IPC.chooseFolder, async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Choose a game folder",
      // Reopening on the folder the caller expects; a bad path is ignored by
      // AppKit rather than refused, so it needs no validation here.
      ...(defaultPath ? { defaultPath } : {}),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  // Bounds are high-frequency, fire-and-forget layout updates from the
  // renderer (`ipcRenderer.send`), not request/response calls.
  ipcMain.on(IPC.panelBounds, (_event, bounds: PanelBounds) => {
    panel.setBounds(bounds);
  });
  ipcMain.handle(IPC.panelTarget, () => panel.targetId());
}

/**
 * Tell core which view to drive.
 *
 * Core would otherwise launch a headless Chrome of its own and the user would
 * be watching a different page from the agent — the exact split the shell
 * migration exists to remove. The target id is handed over rather than
 * discovered: core guessing by url or title would eventually pick the editor's
 * own window and start driving the application instead of the page inside it.
 *
 * Best-effort by design. A failure here leaves core on its own browser, which
 * is degraded but working, and is a far better outcome than refusing to open
 * the window.
 */
async function attachPanelToCore(panel: BrowserPanel): Promise<void> {
  const targetId = await panel.targetId();
  if (!targetId) {
    console.error("browser panel exposed no devtools target; core keeps its own browser");
    return;
  }
  try {
    const response = await fetch(`${CORE_ORIGIN}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "attach-panel",
        method: "browser_attach",
        params: { endpoint: `http://127.0.0.1:${REMOTE_DEBUGGING_PORT}`, targetId },
      }),
    });
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error) {
      console.error(`core refused the browser panel: ${body.error.message ?? "unknown error"}`);
    }
  } catch (error) {
    console.error(`could not hand the browser panel to core: ${String(error)}`);
  }
}

app.whenReady().then(async () => {
  // Unpackaged runs show Electron's own icon in the dock; a packaged build takes
  // it from the bundle and `app.dock` does not need telling.
  const icon = brandIcon();
  if (icon && process.platform === "darwin") app.dock?.setIcon(icon);

  const startup = await startCore();
  const win = createWindow();
  const panel = createBrowserPanel(win);
  registerIpc(panel);

  win.once("closed", () => panel.destroy());

  const ready = startup === "starting" && (await waitForCore(100));
  if (ready) {
    await attachPanelToCore(panel);
    await win.loadURL(`${CORE_ORIGIN}/`);
  } else {
    await showFailure(win, startup);
  }
  win.show();
  win.focus();
});

// The window is the app: there is no dock-relaunch path, and a surviving core
// would hold :8765 against the next launch.
app.on("window-all-closed", () => {
  stopCore();
  app.quit();
});

app.on("before-quit", stopCore);
