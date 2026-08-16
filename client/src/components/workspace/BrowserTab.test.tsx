import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserTab } from "./BrowserTab";
import type { AgentEvent } from "../../lib/rpc";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), connectEvents: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: mocks.rpc, connectEvents: mocks.connectEvents }));

let emit: ((event: AgentEvent) => void) | null = null;
const disconnect = vi.fn();

/** Every call made, so a test can assert on ordering and arguments. */
const calls = (): Array<[string, Record<string, unknown>]> =>
  mocks.rpc.mock.calls.map(([method, params]) => [method, params ?? {}]);

const callsTo = (method: string) => calls().filter(([name]) => name === method);

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation((method: string) =>
    method === "browser_status" ? Promise.resolve({ running: false }) : Promise.resolve({}),
  );
  disconnect.mockReset();
  mocks.connectEvents.mockReset();
  mocks.connectEvents.mockImplementation((onEvent: (event: AgentEvent) => void) => {
    emit = onEvent;
    return disconnect;
  });
});

afterEach(() => {
  cleanup();
  emit = null;
});

describe("BrowserTab", () => {
  it("paints frames from the event bus", async () => {
    render(<BrowserTab />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit?.({ type: "browser.frame", data: "AAAA" } as AgentEvent);
    });
    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  });

  it("paints the current page as soon as the tab is re-opened", async () => {
    // Switching to another tab unmounts this panel, and chrome only sends a
    // frame when something repaints — so coming back to a still page left the
    // tab blank, which read as the browser having reset itself. The frame now
    // rides back in the cast-start reply, which cannot race the event stream
    // the panel is re-opening at the same moment.
    mocks.rpc.mockImplementation((method: string) => {
      if (method === "browser_status")
        return Promise.resolve({ running: true, url: "https://example.com/", title: "Example" });
      if (method === "browser_cast_start")
        return Promise.resolve({ casting: true, frame: { data: "RESTORED" } });
      return Promise.resolve({});
    });

    render(<BrowserTab />);

    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,RESTORED");
    // And never the empty state, which is what made it look reset.
    expect(screen.queryByText(/Nothing open yet/)).toBeNull();
  });

  it("recovers a frame instead of sitting on the placeholder forever", async () => {
    // The reported hang: the panel showed "Reconnecting to Google…" over a
    // live page indefinitely. Chrome pushes a frame only when the page
    // repaints, and a loaded page that is just sitting there repaints never —
    // so if the cast-start reply carries no frame, nothing else ever arrives.
    mocks.rpc.mockImplementation((method: string) => {
      if (method === "browser_status")
        return Promise.resolve({ running: true, url: "https://www.google.com/", title: "Google" });
      if (method === "browser_cast_start") return Promise.resolve({ casting: true });
      if (method === "browser_frame") return Promise.resolve({ frame: { data: "RECOVERED" } });
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<BrowserTab />);
      // Recovery waits for a second empty poll, so the first one cannot spend
      // a capture racing the cast-start reply.
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,RECOVERED");
  });

  it("does not keep asking for a frame once it has one", async () => {
    mocks.rpc.mockImplementation((method: string) => {
      if (method === "browser_status")
        return Promise.resolve({ running: true, url: "https://example.com/", title: "Example" });
      if (method === "browser_cast_start")
        return Promise.resolve({ casting: true, frame: { data: "FIRST" } });
      return Promise.resolve({});
    });

    render(<BrowserTab />);
    await screen.findByRole("img");
    // A capture per poll on a page that is already painted would be pure cost.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(callsTo("browser_frame")).toHaveLength(0);
  });

  it("asks for frames no larger than the panel draws them", async () => {
    // Casting a fixed width pushed 1.14 MB/s of base64 through the event
    // stream regardless of how small the panel was.
    render(<BrowserTab />);
    await waitFor(() => expect(callsTo("browser_cast_start")).toHaveLength(1));
    const params = callsTo("browser_cast_start")[0][1];
    // jsdom reports a zero-size box, so the width is omitted rather than sent
    // as 0 — core then keeps its own default instead of casting a sliver.
    expect(params.width === undefined || (params.width as number) > 0).toBe(true);
  });

  it("stops the screencast when the tab goes away", async () => {
    const view = render(<BrowserTab />);
    await waitFor(() => expect(callsTo("browser_cast_start")).toHaveLength(1));
    view.unmount();
    // A cast left running behind a closed tab keeps pushing JPEGs onto the
    // same bus the agent's tokens use, for nobody to look at.
    await waitFor(() => expect(callsTo("browser_cast_stop")).toHaveLength(1));
    expect(disconnect).toHaveBeenCalled();
  });

  it("sends a typed address to navigate and a typed phrase to search", async () => {
    render(<BrowserTab />);
    const field = await screen.findByLabelText("Address or search");

    fireEvent.change(field, { target: { value: "sketchfab.com/tags/spaceship" } });
    fireEvent.submit(field);
    await waitFor(() => expect(callsTo("browser_navigate")).toHaveLength(1));
    expect(callsTo("browser_navigate")[0][1]).toEqual({ url: "sketchfab.com/tags/spaceship" });

    fireEvent.change(field, { target: { value: "low poly spaceship" } });
    fireEvent.submit(field);
    // A phrase is not a url, and navigating to it would fail in core rather
    // than doing the obvious thing.
    await waitFor(() => expect(callsTo("browser_search")).toHaveLength(1));
    expect(callsTo("browser_search")[0][1]).toEqual({ query: "low poly spaceship" });
  });

  it("does not overwrite the address bar while it is being typed in", async () => {
    mocks.rpc.mockImplementation((method: string) =>
      method === "browser_status"
        ? Promise.resolve({ running: true, url: "https://example.com/", title: "Example" })
        : Promise.resolve({}),
    );
    render(<BrowserTab />);
    const field = await screen.findByLabelText<HTMLInputElement>("Address or search");
    await waitFor(() => expect(field.value).toBe("https://example.com/"));

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "half-typed-add" } });
    // A status poll landing mid-edit used to replace what the user was still
    // typing with the current url.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(field.value).toBe("half-typed-add");
  });

  it("forwards a click as a press and a release in viewport coordinates", async () => {
    render(<BrowserTab />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit?.({ type: "browser.frame", data: "AAAA" } as AgentEvent);
    });
    const image = await screen.findByRole("img");
    // jsdom lays nothing out, so the frame's on-screen box is stubbed to make
    // the scaling assertion meaningful.
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 640,
      height: 400,
      right: 640,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.click(screen.getByRole("application"), { clientX: 320, clientY: 200, detail: 1 });
    await waitFor(() => expect(callsTo("browser_input").length).toBeGreaterThanOrEqual(2));
    const [down, up] = callsTo("browser_input");
    // Half the rendered width maps to half the 1280-wide viewport core owns.
    expect(down[1]).toMatchObject({ kind: "down", x: 640, y: 400 });
    expect(up[1]).toMatchObject({ kind: "up", x: 640, y: 400 });
  });

  it("forwards mouse movement, throttled, so the page can hover", async () => {
    // Without this the panel reacted to nothing until it was clicked: no link
    // highlight, no cursor change, no hover menus. That is most of why it read
    // as a picture of a browser rather than a browser.
    render(<BrowserTab />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit?.({ type: "browser.frame", data: "AAAA" } as AgentEvent);
    });
    const image = await screen.findByRole("img");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 640,
      height: 400,
      right: 640,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const surface = screen.getByRole("application");
    fireEvent.mouseMove(surface, { clientX: 320, clientY: 200 });
    await waitFor(() => expect(callsTo("browser_input")).toHaveLength(1));
    expect(callsTo("browser_input")[0][1]).toEqual({ kind: "move", x: 640, y: 400 });

    // A pointer emits far more moves than a page repaints, and each one is a
    // round trip; the ones inside the throttle window are dropped.
    fireEvent.mouseMove(surface, { clientX: 321, clientY: 201 });
    fireEvent.mouseMove(surface, { clientX: 322, clientY: 202 });
    expect(callsTo("browser_input")).toHaveLength(1);
  });

  it("maps clicks through the painted frame, not the element box", async () => {
    // `object-contain` letterboxes whenever the panel and the viewport differ
    // in aspect, so the image element is bigger than the picture inside it.
    // Mapping against the element box offset every click by the letterbox.
    mocks.rpc.mockImplementation((method: string) =>
      method === "browser_status"
        ? Promise.resolve({ running: true, viewport: { width: 1000, height: 500 } })
        : Promise.resolve({}),
    );
    render(<BrowserTab />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit?.({ type: "browser.frame", data: "AAAA" } as AgentEvent);
    });
    const image = await screen.findByRole("img");
    // A 2:1 frame in a square box: painted area is 400x200, pinned to the top.
    Object.defineProperty(image, "naturalWidth", { value: 2000, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: 1000, configurable: true });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0,
      toJSON: () => ({}),
    });

    const surface = screen.getByRole("application");
    // Centre of the painted strip -> centre of the viewport.
    fireEvent.click(surface, { clientX: 200, clientY: 100 });
    await waitFor(() => expect(callsTo("browser_input").length).toBeGreaterThanOrEqual(2));
    expect(callsTo("browser_input")[0][1]).toMatchObject({ kind: "down", x: 500, y: 250 });

    // Below the painted strip is letterbox, not page: no input, but the panel
    // still takes focus, or one stray click would cost the user the keyboard.
    mocks.rpc.mockClear();
    fireEvent.click(surface, { clientX: 200, clientY: 350 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(callsTo("browser_input")).toHaveLength(0);
    expect(document.activeElement).toBe(surface);
  });

  it("takes the page's cursor shape so the pointer changes over links", async () => {
    // The panel is an image, so its cursor never changed on its own — an arrow
    // over every link, which reads as "picture of a page" on every mouse move.
    mocks.rpc.mockImplementation((method: string) => {
      if (method === "browser_status") return Promise.resolve({ running: false });
      if (method === "browser_input") return Promise.resolve({ ok: true, cursor: "pointer" });
      return Promise.resolve({});
    });
    render(<BrowserTab />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit?.({ type: "browser.frame", data: "AAAA" } as AgentEvent);
    });
    const image = await screen.findByRole("img");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0,
      toJSON: () => ({}),
    });

    const surface = screen.getByRole("application");
    fireEvent.mouseMove(surface, { clientX: 320, clientY: 200 });
    await waitFor(() => expect(surface.style.cursor).toBe("pointer"));
  });

  it("reports its rect to the native shell and hides under overlays", async () => {
    // Under Electron the panel is a real WebContentsView the shell positions
    // over this element, so this component reports geometry instead of
    // painting. A native view floats above the DOM with its own z-order, so a
    // portalled Radix menu would open *behind* it unless the view hides.
    const setPanelBounds = vi.fn();
    const bridge = {
      shell: "electron" as const,
      platform: "darwin",
      chooseFolder: vi.fn(),
      setPanelBounds,
      panelTarget: vi.fn(),
    };
    // contextBridge freezes what it exposes, so the real object cannot be
    // spied on in the running app — which is why this is asserted here.
    Object.defineProperty(window, "cali", { value: bridge, configurable: true });
    // jsdom implements no ResizeObserver, and the geometry effect guards on it
    // — without a stub it returns before reporting anything.
    const RealRO = window.ResizeObserver;
    window.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;

    try {
      render(<BrowserTab />);
      await waitFor(() => expect(setPanelBounds).toHaveBeenCalled());
      expect(setPanelBounds.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true });

      // A dialog portalled to <body> is how every overlay in this app arrives.
      const overlay = document.createElement("div");
      overlay.setAttribute("role", "dialog");
      document.body.appendChild(overlay);
      await waitFor(() =>
        expect(setPanelBounds.mock.calls.at(-1)?.[0]).toMatchObject({ visible: false }),
      );

      overlay.remove();
      await waitFor(() =>
        expect(setPanelBounds.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }),
      );
    } finally {
      Reflect.deleteProperty(window, "cali");
      window.ResizeObserver = RealRO;
    }
  });

  it("offers a way out to the real browser", async () => {
    mocks.rpc.mockImplementation((method: string) =>
      method === "browser_status"
        ? Promise.resolve({ running: true, url: "https://example.com/x", title: "Example" })
        : Promise.resolve({}),
    );
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    render(<BrowserTab />);
    const button = await screen.findByRole("button", { name: "Open in your browser" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    // This panel cannot select text or open devtools; when the task stops
    // being "watch the agent" the real browser should be one click away, on
    // the same page.
    expect(opened).toHaveBeenCalledWith("https://example.com/x", "_blank", "noopener");
    opened.mockRestore();
  });

  it("leaves editor shortcuts alone and forwards plain keys", async () => {
    render(<BrowserTab />);
    const surface = await screen.findByRole("application");

    fireEvent.keyDown(surface, { key: "r", metaKey: true });
    expect(callsTo("browser_input")).toHaveLength(0);

    fireEvent.keyDown(surface, { key: "a" });
    fireEvent.keyDown(surface, { key: "Enter" });
    await waitFor(() => expect(callsTo("browser_input")).toHaveLength(2));
    expect(callsTo("browser_input")[0][1]).toEqual({ kind: "text", text: "a" });
    expect(callsTo("browser_input")[1][1]).toEqual({ kind: "key", key: "Enter" });
  });

  it("surfaces a page error without losing the frame", async () => {
    render(<BrowserTab />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit?.({ type: "browser.frame", data: "AAAA" } as AgentEvent);
      emit?.({ type: "browser.error", text: "TypeError: game is not defined" } as AgentEvent);
    });
    expect(await screen.findByText("TypeError: game is not defined")).toBeTruthy();
    expect(screen.getByRole("img")).toBeTruthy();
  });
});
