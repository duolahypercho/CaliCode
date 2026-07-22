import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useSDK } from "@/context/sdk"
import "./caliber-game.css"

/** Caliber's Rust core service (caliber-core); the Arcade degrades gracefully without it. */
const CORE_URL = "http://localhost:4870"

/**
 * Caliber Arcade — the gaming pane on the right side of a session.
 *
 * Self-contained by design: it renders the project's running game (any local
 * dev-server URL) inside a CRT-styled screen with its own controls, status
 * readouts, and console. Games can optionally talk back over postMessage with
 * `{ source: "caliber-game", type: "ready" | "runtime_error" | "game_event" | "fps", ... }`.
 */

const STORE_OPEN = "caliber.arcade.open"
const STORE_URL = "caliber.arcade.url"
const STORE_WIDTH = "caliber.arcade.width"

const SCAN_PORTS = [5173, 3000, 8080, 4321, 1234, 8000]
const WIDTH_MIN = 320
const WIDTH_MAX = 1600

/** The game is the primary surface: default to ~60% of the window. */
function defaultWidth(): number {
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(window.innerWidth * 0.6)))
}

interface ConsoleLine {
  kind: "info" | "event" | "error"
  text: string
}

function readNumber(key: string, fallback: number): number {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw >= WIDTH_MIN && raw <= WIDTH_MAX ? raw : fallback
}

export function CaliberGamePanel() {
  const sdk = useSDK()
  const isDesktop = createMediaQuery("(min-width: 768px)")
  // Open by default — the game is the main part of Caliber.
  const [open, setOpen] = createSignal(localStorage.getItem(STORE_OPEN) !== "0")
  const [url, setUrl] = createSignal(localStorage.getItem(STORE_URL) ?? "")
  const [width, setWidth] = createSignal(readNumber(STORE_WIDTH, defaultWidth()))
  const [loadedUrl, setLoadedUrl] = createSignal<string | null>(null)
  const [frameKey, setFrameKey] = createSignal(0)
  const [status, setStatus] = createSignal<"idle" | "live" | "error">("idle")
  const [fps, setFps] = createSignal<number | null>(null)
  const [events, setEvents] = createSignal(0)
  const [lines, setLines] = createSignal<ConsoleLine[]>([])
  const [consoleOpen, setConsoleOpen] = createSignal(false)
  const [scanning, setScanning] = createSignal(false)
  const [editMode, setEditMode] = createSignal(false)
  const [library, setLibrary] = createSignal<Array<{ name: string; directory: string }>>([])
  const [activity, setActivity] = createSignal<Array<{ actor: string; action: string; detail: string; at_ms: number }>>([])
  const [picked, setPicked] = createSignal<{ entity: string; props: Record<string, unknown> } | null>(null)
  let stage: HTMLDivElement | undefined
  let frameEl: HTMLIFrameElement | undefined
  let lastMtime = 0
  let autotestPending = false

  const postToGame = (msg: Record<string, unknown>) => {
    frameEl?.contentWindow?.postMessage(msg, "*")
  }

  /** Report a user action to the shared multi-actor feed (fire and forget). */
  const report = (action: string, detail = "") => {
    void fetch(`${CORE_URL}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "you", action, detail }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined)
  }

  const toggleEdit = () => {
    const on = !editMode()
    setEditMode(on)
    if (!on) setPicked(null)
    postToGame({ type: "caliber:edit-mode", on })
    log("info", on ? "EDIT MODE ON — CLICK ANYTHING IN THE GAME" : "EDIT MODE OFF")
  }

  const setProp = (entity: string, key: string, value: unknown) => {
    postToGame({ type: "caliber:set-prop", entity, key, value })
    setPicked((p) => (p && p.entity === entity ? { ...p, props: { ...p.props, [key]: value } } : p))
  }

  const record = () => {
    report("record", "3s @6fps")
    log("info", "RECORDING 3S OF LIVE ANIMATION @6FPS")
    postToGame({ type: "caliber:record", durationMs: 3000, fps: 6 })
  }

  const playtest = () => {
    report("playtest", "6s sweep")
    log("info", "PLAYTEST RUNNING — SWEEP LEFT AND RIGHT FOR 6S")
    postToGame({
      type: "caliber:playtest",
      durationMs: 6000,
      inputs: [
        { code: "ArrowRight", atMs: 0, forMs: 1500 },
        { code: "ArrowLeft", atMs: 1600, forMs: 1500 },
        { code: "ArrowRight", atMs: 3200, forMs: 1200 },
        { code: "ArrowLeft", atMs: 4500, forMs: 1200 },
      ],
    })
  }

  const saveConfig = async () => {
    const target = loadedUrl() ?? ""
    const match = target.match(/\/play\/([a-z0-9-]+)\//)
    if (!match) return log("error", "SAVE NEEDS A CORE-SERVED GAME (/play/...)")
    const handler = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; config?: unknown } | null
      if (d?.source !== "caliber-game" || d.type !== "edit_config") return
      window.removeEventListener("message", handler)
      void fetch(`${CORE_URL}/games/${match[1]}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d.config),
      })
        .then((res) => (res.ok ? log("event", "LOOK SAVED TO config.json") : log("error", "SAVE FAILED")))
        .catch((err: Error) => log("error", `SAVE FAILED — ${err.message}`))
    }
    window.addEventListener("message", handler)
    postToGame({ type: "caliber:get-config" })
  }

  const log = (kind: ConsoleLine["kind"], text: string) =>
    setLines((prev) => [...prev.slice(-149), { kind, text }])

  const toggle = () => {
    const next = !open()
    setOpen(next)
    localStorage.setItem(STORE_OPEN, next ? "1" : "0")
  }

  const insert = () => {
    const target = url().trim()
    if (!target) return
    localStorage.setItem(STORE_URL, target)
    setLoadedUrl(target)
    setFrameKey((k) => k + 1)
    setStatus("idle")
    setFps(null)
    lastMtime = 0
    log("info", `LOADING ${target}`)
    report("load", target.replace(/^https?:\/\/[^/]+/, ""))
  }

  const eject = () => {
    setLoadedUrl(null)
    setStatus("idle")
    setFps(null)
    log("info", "EJECTED")
    void refreshLibrary()
  }

  const refreshLibrary = async () => {
    const directory = sdk().directory
    if (!directory) return
    try {
      const res = await fetch(`${CORE_URL}/games/discover?directory=${encodeURIComponent(directory)}`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) setLibrary((await res.json()) as Array<{ name: string; directory: string }>)
    } catch {
      // core offline; library stays empty
    }
  }

  const playFromLibrary = async (directory: string) => {
    try {
      const res = await fetch(`${CORE_URL}/games/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory }),
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) throw new Error(await res.text())
      const game = (await res.json()) as { play_url: string }
      setUrl(game.play_url)
      localStorage.setItem(STORE_URL, game.play_url)
      insert()
    } catch (err) {
      log("error", `LOAD FAILED — ${(err as Error).message}`)
    }
  }

  const found = (candidate: string) => {
    setUrl(candidate)
    localStorage.setItem(STORE_URL, candidate)
    log("event", `FOUND SERVER ${candidate}`)
    setScanning(false)
    insert()
  }

  const scan = async () => {
    setScanning(true)
    // Preferred path: the Rust core does real TCP probes.
    try {
      const res = await fetch(`${CORE_URL}/scan`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const hits = (await res.json()) as Array<{ port: number; url: string }>
        log("info", `CORE SCAN: ${hits.length} SERVER(S)`)
        const hit = hits.find((h) => h.url !== window.location.origin)
        if (hit) return found(hit.url)
        log("error", "NO LOCAL SERVER FOUND")
        setScanning(false)
        return
      }
    } catch {
      log("info", "CORE OFFLINE — FALLBACK SCAN")
    }
    // Fallback: probe from the browser.
    for (const port of SCAN_PORTS) {
      const candidate = `http://localhost:${port}`
      try {
        await fetch(candidate, { mode: "no-cors", signal: AbortSignal.timeout(900) })
        return found(candidate)
      } catch {
        // nothing listening on this port; keep scanning
      }
    }
    log("error", "NO LOCAL SERVER FOUND")
    setScanning(false)
  }

  const newGame = async () => {
    const directory = sdk().directory
    if (!directory) {
      log("error", "NO PROJECT DIRECTORY IN THIS SESSION")
      return
    }
    try {
      const res = await fetch(`${CORE_URL}/games/scaffold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory, name: "New Game" }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(await res.text())
      const game = (await res.json()) as { slug: string; directory: string; play_url: string }
      log("event", `SCAFFOLDED ${game.directory}`)
      setUrl(game.play_url)
      localStorage.setItem(STORE_URL, game.play_url)
      insert()
    } catch (err) {
      log("error", `NEW GAME FAILED — IS CALIBER-CORE RUNNING? (${(err as Error).message})`)
    }
  }

  const fullscreen = () => {
    void stage?.requestFullscreen?.()
  }

  const startResize = (down: PointerEvent) => {
    down.preventDefault()
    const startX = down.clientX
    const startWidth = width()
    const move = (e: PointerEvent) => {
      const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startWidth + (startX - e.clientX)))
      setWidth(next)
    }
    const up = () => {
      localStorage.setItem(STORE_WIDTH, String(width()))
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  onMount(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as
        | { source?: string; type?: string; message?: string; name?: string; value?: number; entity?: string; props?: Record<string, unknown> }
        | null
      if (!data || data.source !== "caliber-game") return
      switch (data.type) {
        case "ready":
          setStatus("live")
          log("event", "GAME READY")
          if (autotestPending) {
            autotestPending = false
            setTimeout(() => playtest(), 400)
          }
          break
        case "runtime_error":
          setStatus("error")
          log("error", `RUNTIME ${data.message ?? "unknown error"}`)
          break
        case "game_event":
          setEvents((n) => n + 1)
          log("event", `EVENT ${data.name ?? "?"}`)
          break
        case "fps":
          if (typeof data.value === "number") setFps(Math.round(data.value))
          break
        case "record_result": {
          const r = data as unknown as { frames: string[]; fps: number; durationMs: number }
          const target = loadedUrl() ?? ""
          const match = target.match(/\/play\/([a-z0-9-]+)\//)
          if (!match) {
            log("error", "RECORDING NEEDS A CORE-SERVED GAME")
            break
          }
          log("info", `UPLOADING ${r.frames.length} FRAME(S)`)
          void fetch(`${CORE_URL}/games/${match[1]}/recording`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ frames: r.frames, fps: r.fps, duration_ms: r.durationMs }),
          })
            .then(async (res) => {
              if (!res.ok) throw new Error(await res.text())
              const saved = (await res.json()) as { dir: string; frame_count: number }
              log("event", `RECORDING SAVED — ${saved.frame_count} FRAMES IN ${saved.dir}`)
              log("info", "ASK THE AGENT TO READ recording/recording.json FRAME BY FRAME")
              setConsoleOpen(true)
            })
            .catch((err: Error) => log("error", `RECORDING SAVE FAILED — ${err.message}`))
          break
        }
        case "playtest_result": {
          const r = data as unknown as {
            events: Array<{ type: string; name?: string; message?: string }>
            frames: number
            durationMs: number
            finalScore?: number
          }
          const errors = r.events.filter((e) => e.type === "runtime_error")
          setEvents((n) => n + r.events.length)
          log(
            errors.length > 0 ? "error" : "event",
            `PLAYTEST ${errors.length > 0 ? "FAILED" : "PASSED"} — ${r.frames} FRAMES, ${r.events.length} EVENT(S)` +
              (r.finalScore !== undefined ? `, SCORE ${r.finalScore}` : ""),
          )
          for (const e of r.events.slice(0, 12)) log(e.type === "runtime_error" ? "error" : "info", `  ${e.name ?? e.message ?? e.type}`)
          setConsoleOpen(true)
          break
        }
        case "edit_pick": {
          const pick = data as unknown as { entity: string; props: Record<string, unknown> }
          setPicked({ entity: pick.entity, props: { ...pick.props } })
          log("event", `PICKED ${pick.entity.toUpperCase()}`)
          break
        }
      }
    }
    window.addEventListener("message", onMessage)
    onCleanup(() => window.removeEventListener("message", onMessage))
    void refreshLibrary()

    // Hot reload + auto-playtest: when the loaded cartridge's files change
    // (e.g. an agent turn edited the game), reload it and verify by playing.
    const activityPoll = setInterval(async () => {
      try {
        const res = await fetch(`${CORE_URL}/activity`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) setActivity((await res.json()) as Array<{ actor: string; action: string; detail: string; at_ms: number }>)
      } catch {
        // core offline
      }
    }, 2000)
    onCleanup(() => clearInterval(activityPoll))

    const poll = setInterval(async () => {
      const target = loadedUrl()
      const match = target?.match(/\/play\/([a-z0-9-]+)\//)
      if (!match) return
      try {
        const res = await fetch(`${CORE_URL}/games/${match[1]}/mtime`, { signal: AbortSignal.timeout(2000) })
        if (!res.ok) return
        const { mtime } = (await res.json()) as { mtime: number }
        if (lastMtime !== 0 && mtime > lastMtime) {
          log("event", "CARTRIDGE UPDATED — RELOADING + AUTO-PLAYTEST")
          autotestPending = true
          setFrameKey((k) => k + 1)
        }
        lastMtime = Math.max(lastMtime, mtime)
      } catch {
        // core offline; skip this tick
      }
    }, 3000)
    onCleanup(() => clearInterval(poll))
  })

  return (
    <Show when={isDesktop()}>
      <Show
        when={open()}
        fallback={
          <button type="button" class="caliber-arcade-toggle" onClick={toggle} aria-label="Open Caliber Arcade">
            ▲ ARCADE
          </button>
        }
      >
        <aside class="caliber-arcade shrink-0" style={{ width: `${width()}px` }} aria-label="Caliber Arcade game panel">
          <div class="caliber-arcade__grip" onPointerDown={startResize} role="separator" aria-orientation="vertical" />

          <header class="caliber-arcade__header">
            <span class="caliber-arcade__led" data-state={status()} />
            <span class="caliber-arcade__title">
              CALIBER<em>◆</em>ARCADE
            </span>
            <span class="caliber-arcade__spacer" />
            <button type="button" onClick={fullscreen} disabled={!loadedUrl()}>
              Full
            </button>
            <button type="button" data-accent="magenta" onClick={toggle}>
              Hide
            </button>
          </header>

          <div class="caliber-arcade__deck">
            <input
              class="caliber-arcade__url"
              value={url()}
              placeholder="press NEW GAME — or paste a game url"
              spellcheck={false}
              onInput={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && insert()}
              aria-label="Game URL"
            />
            <button type="button" onClick={insert} disabled={url().trim() === ""}>
              Insert Coin
            </button>
            <button type="button" onClick={scan} disabled={scanning()}>
              {scanning() ? "Scanning" : "Scan"}
            </button>
            <Show when={!loadedUrl()}>
              <button type="button" data-accent="magenta" onClick={newGame}>
                New Game
              </button>
            </Show>
            <Show when={loadedUrl()}>
              <button type="button" data-on={editMode() ? "true" : undefined} onClick={toggleEdit}>
                Edit
              </button>
              <button type="button" onClick={playtest}>
                Playtest
              </button>
              <button type="button" onClick={record}>
                Record
              </button>
              <Show when={editMode()}>
                <button type="button" onClick={saveConfig}>
                  Save Look
                </button>
              </Show>
              <button type="button" onClick={() => setFrameKey((k) => k + 1)}>
                Reload
              </button>
              <button type="button" data-accent="magenta" onClick={eject}>
                Eject
              </button>
            </Show>
          </div>

          <div class="caliber-arcade__stage" ref={stage}>
            <div class="caliber-arcade__crt">
              <Show
                when={loadedUrl()}
                fallback={
                  <div class="caliber-arcade__idle">
                    <div class="caliber-arcade__idle-mark">CALIBER</div>
                    <div class="caliber-arcade__idle-copy">
                      PRESS NEW GAME — OR PICK A CARTRIDGE FROM YOUR PROJECT.
                    </div>
                    <Show when={library().length > 0}>
                      <div class="caliber-arcade__library">
                        <For each={library()}>
                          {(game) => (
                            <button type="button" onClick={() => void playFromLibrary(game.directory)}>
                              ▸ {game.name}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                }
              >
                {(target) => (
                  <>
                    <iframe
                      ref={frameEl}
                      // frameKey forces a clean reload of the cartridge
                      data-key={frameKey()}
                      src={`${target()}${target().includes("?") ? "&" : "?"}caliber=${frameKey()}`}
                      title="Caliber game preview"
                      sandbox="allow-scripts allow-same-origin allow-pointer-lock"
                      allow="fullscreen; gamepad; autoplay"
                    />
                    <div class="caliber-arcade__scanlines" />
                  </>
                )}
              </Show>
            </div>
          </div>

          <Show when={editMode() && picked()}>
            {(pick) => (
              <div class="caliber-arcade__inspector">
                <div class="caliber-arcade__inspector-title">{pick().entity.toUpperCase()}</div>
                <For each={Object.entries(pick().props)}>
                  {([key, value]) => (
                    <label class="caliber-arcade__prop">
                      <span>{key}</span>
                      <Show
                        when={typeof value === "string" && String(value).startsWith("#")}
                        fallback={
                          <input
                            type="number"
                            step="any"
                            value={String(value)}
                            onInput={(e) => {
                              const n = Number(e.currentTarget.value)
                              if (Number.isFinite(n)) setProp(pick().entity, key, n)
                            }}
                          />
                        }
                      >
                        <input
                          type="color"
                          value={String(value)}
                          onInput={(e) => setProp(pick().entity, key, e.currentTarget.value)}
                        />
                      </Show>
                    </label>
                  )}
                </For>
              </div>
            )}
          </Show>

          <Show when={activity().length > 0}>
            <div class="caliber-arcade__agents" role="status" aria-label="Live agent activity">
              <span class="caliber-arcade__agents-title">LIVE</span>
              <For each={activity().slice(-4).reverse()}>
                {(a) => (
                  <span class="caliber-arcade__agent-chip" data-actor={a.actor}>
                    <b>{a.actor}</b> {a.action}
                    {a.detail !== "" ? ` · ${a.detail}` : ""} · {Math.max(0, Math.round((Date.now() - a.at_ms) / 1000))}s
                  </span>
                )}
              </For>
            </div>
          </Show>

          <div class="caliber-arcade__readouts">
            <span>
              FPS <b>{fps() ?? "--"}</b>
            </span>
            <span>
              EVT <b>{events()}</b>
            </span>
            <span>
              SIG <b>{status().toUpperCase()}</b>
            </span>
            <span class="caliber-arcade__spacer" />
            <button type="button" data-on={consoleOpen() ? "true" : undefined} onClick={() => setConsoleOpen((v) => !v)}>
              Console
            </button>
          </div>

          <Show when={consoleOpen()}>
            <div class="caliber-arcade__console" role="log">
              <Show when={lines().length === 0}>
                <div>NO SIGNALS YET</div>
              </Show>
              <For each={lines()}>{(line) => <div data-kind={line.kind}>{line.text}</div>}</For>
            </div>
          </Show>
        </aside>
      </Show>
    </Show>
  )
}
