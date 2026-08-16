/**
 * The only bridge across `contextIsolation`.
 *
 * Every member below is a named operation with a fixed channel. `ipcRenderer`
 * itself — and any generic `invoke(channel, ...args)` passthrough — must never
 * be exposed: the BROWSER panel loads arbitrary pages into this app, and a
 * broad bridge would turn any script on any of those pages into a caller of
 * the main process. Adding a capability here means adding a method, never a
 * parameter that names a channel.
 */

import { contextBridge, ipcRenderer } from "electron";

import { IPC, type CaliBridge, type PanelBounds } from "./ipc";

const bridge: CaliBridge = {
  // Synchronous, because `hasOverlayWindowControls()` in src/lib/desktop.ts
  // runs at render time to decide whether the header reserves space for the
  // macOS traffic lights. An async probe resolves after that first paint, so
  // the lights would land on top of our own chrome.
  shell: "electron",
  platform: process.platform,

  chooseFolder: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC.chooseFolder, defaultPath) as Promise<string | null>,

  // Fire-and-forget: bounds arrive on every resize and scroll frame, and a
  // reply the renderer would discard only adds latency to that path.
  setPanelBounds: (bounds: PanelBounds) => ipcRenderer.send(IPC.panelBounds, bounds),

  panelTarget: () => ipcRenderer.invoke(IPC.panelTarget) as Promise<string | null>,
};

contextBridge.exposeInMainWorld("cali", bridge);
