import type { Session } from "@opencode-ai/sdk/v2/client"
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { useCommand } from "@/context/command"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { tabKey, useTabs, type SessionTab, type Tab } from "@/context/tabs"
import { useSettingsCommand } from "@/components/settings-dialog"
import { sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"

/**
 * Caliber sidebar — implements the Games → Sessions tree from the Caliber design
 * (claude.ai/design · Caliber.dc.html). Monochrome, mono-type, near-black.
 *
 * Games come from caliber-core's discover endpoint; sessions are the open tabs
 * grouped by their working directory, so each game expands to its own chats.
 */
const CORE_URL = "http://localhost:4870"
const ARCADE_URL_KEY = "caliber.arcade.url"
const ARCADE_OPEN_KEY = "caliber.arcade.open"

const FONT_MONO = "ui-monospace, 'SF Mono', 'Space Mono', Menlo, monospace"

const DOT_DEFAULT = "#6a6a6a"
const DOT_COLORS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Neutral", value: DOT_DEFAULT },
  { label: "Red", value: "#e0696e" },
  { label: "Amber", value: "#d1a054" },
  { label: "Green", value: "#8bb58b" },
  { label: "Blue", value: "#6fa6bf" },
  { label: "Purple", value: "#b492d6" },
]
const PIN_KEY = "caliber.session.pins"
const COLOR_KEY = "caliber.session.colors"

// Compact context menu (Tailwind v4 important suffix).
const MENU_CONTENT = "min-w-[7.5rem]! p-1!"
const MENU_ITEM = "px-2! py-1! text-[12px]! leading-none! gap-2!"

function readMap<T>(key: string): Record<string, T> {
  if (typeof localStorage === "undefined") return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}")
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {}
  } catch {
    return {}
  }
}

type DiscoveredGame = { name: string; directory: string }
type GameEntry = { directory: string; name: string; game?: DiscoveredGame }
type ArchivedSession = { id: string; title: string; directory: string }

export function CaliberSidebar() {
  const tabs = useTabs()
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const sync = useServerSync()
  const openSettings = useSettingsCommand()

  const mac = () => platform.platform === "desktop" && platform.os === "macos"
  const desktop = () => platform.platform === "desktop"

  const [query, setQuery] = createSignal("")
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const [busy, setBusy] = createSignal(false)
  const [pins, setPins] = createSignal<Record<string, boolean>>(readMap<boolean>(PIN_KEY))
  const [dotColors, setDotColors] = createSignal<Record<string, string>>(readMap<string>(COLOR_KEY))
  const [renaming, setRenaming] = createSignal<string | undefined>()
  // Bumped after archive/restore/delete to refetch the per-game archived lists.
  const [archivedNonce, setArchivedNonce] = createSignal(0)

  const rootDirectory = () => {
    const path = sync().data.path
    return path?.directory || path?.worktree || path?.home || ""
  }

  const [games, gamesActions] = createResource<DiscoveredGame[], string>(rootDirectory, async (directory) => {
    if (!directory) return []
    try {
      const res = await fetch(`${CORE_URL}/games/discover?directory=${encodeURIComponent(directory)}`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return []
      return (await res.json()) as DiscoveredGame[]
    } catch {
      return []
    }
  })

  // The horizontal tab strip (which normally records tab title/directory) is
  // hidden in this layout, so resolve session info straight from the sync store.
  function sessionData(tab: Tab) {
    if (tab.type !== "session") return undefined
    return serverCtxFor(tab)?.sync.session.peek(tab.sessionId)
  }
  function tabDirectory(tab: Tab) {
    if (tab.type === "draft") return tab.directory
    return sessionData(tab)?.directory ?? tabs.info[tabKey(tab)]?.directory
  }
  function tabTitle(tab: Tab) {
    if (tab.type === "draft") return language.t("command.session.new")
    const title = sessionData(tab)?.title ?? tabs.info[tabKey(tab)]?.title
    return sessionTitle(title) ?? language.t("command.session.new")
  }

  // Ensure every open session tab's data is loaded so it can be grouped/titled.
  createEffect(() => {
    for (const tab of tabs.store) {
      if (tab.type !== "session") continue
      const ctx = serverCtxFor(tab)
      if (!ctx || ctx.sync.session.peek(tab.sessionId)) continue
      void ctx.sync.session.resolve(tab.sessionId).catch(() => {})
    }
  })

  const tabsByDirectory = createMemo(() => {
    const map = new Map<string, Tab[]>()
    for (const tab of tabs.store) {
      const directory = tabDirectory(tab)
      if (!directory) continue
      const list = map.get(directory) ?? []
      list.push(tab)
      map.set(directory, list)
    }
    return map
  })

  // Top-level entries = discovered games ∪ directories that already hold sessions,
  // so every game shows up and no open session is orphaned.
  const entries = createMemo<GameEntry[]>(() => {
    const byDir = new Map<string, GameEntry>()
    for (const game of games() ?? []) byDir.set(game.directory, { directory: game.directory, name: game.name, game })
    for (const directory of tabsByDirectory().keys()) {
      if (!byDir.has(directory)) byDir.set(directory, { directory, name: directory.split("/").pop() || directory })
    }
    const q = query().trim().toLowerCase()
    const all = [...byDir.values()].sort((a, b) => a.name.localeCompare(b.name))
    return q ? all.filter((entry) => entry.name.toLowerCase().includes(q)) : all
  })

  const activeDirectory = createMemo(() => {
    const active = tabs.store.find((tab) => tabKey(tab) === tabs.recentKey())
    return active ? tabDirectory(active) : undefined
  })
  const isOpen = (directory: string) => collapsed()[directory] ?? directory === activeDirectory()
  const toggle = (directory: string) =>
    setCollapsed((prev) => ({ ...prev, [directory]: !(prev[directory] ?? directory === activeDirectory()) }))

  function newSessionIn(directory: string) {
    void tabs.newDraft({ server: server.key, directory })
  }

  async function newGame() {
    const directory = rootDirectory()
    if (!directory || busy()) return
    setBusy(true)
    try {
      const res = await fetch(`${CORE_URL}/games/scaffold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory, name: "New Game" }),
        signal: AbortSignal.timeout(6000),
      })
      if (!res.ok) throw new Error(await res.text())
      showToast({ title: "Game created" })
      void gamesActions.refetch()
    } catch (err) {
      showToast({ title: "Couldn’t create game", description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function launchGame(directory: string) {
    try {
      const res = await fetch(`${CORE_URL}/games/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory }),
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) throw new Error(await res.text())
      const game = (await res.json()) as { play_url: string }
      localStorage.setItem(ARCADE_URL_KEY, game.play_url)
      localStorage.setItem(ARCADE_OPEN_KEY, "1")
      showToast({ title: `Loaded ${directory.split("/").pop() ?? "game"}` })
    } catch (err) {
      showToast({ title: "Couldn’t load game", description: (err as Error).message })
    }
  }

  function serverCtxFor(tab: Tab) {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
    return conn ? global.ensureServerCtx(conn) : undefined
  }

  function closeSession(tab: Tab) {
    const index = tabs.store.findIndex((item) => tabKey(item) === tabKey(tab))
    if (index !== -1) tabs.closeTab(index)
  }

  async function archiveSession(tab: SessionTab) {
    const directory = tabDirectory(tab)
    const ctx = serverCtxFor(tab)
    if (!ctx || !directory) return
    try {
      await ctx.sdk.client.session.update({ directory, sessionID: tab.sessionId, time: { archived: Date.now() } })
      tabs.removeSessionTab({ server: tab.server, sessionId: tab.sessionId })
      setArchivedNonce((value) => value + 1)
      showToast({ title: "Session archived" })
    } catch (err) {
      showToast({ title: "Couldn’t archive session", description: (err as Error).message })
    }
  }

  async function deleteSession(tab: SessionTab) {
    // Permanent — confirm before destroying messages and history.
    if (!window.confirm("Delete this session permanently? This removes all its messages and history.")) return
    const ctx = serverCtxFor(tab)
    if (!ctx) return
    try {
      await ctx.sdk.client.session.delete({ sessionID: tab.sessionId, directory: tabDirectory(tab) })
      tabs.removeSessionTab({ server: tab.server, sessionId: tab.sessionId })
      showToast({ title: "Session deleted" })
    } catch (err) {
      showToast({ title: "Couldn’t delete session", description: (err as Error).message })
    }
  }

  async function loadArchived(directory: string): Promise<ArchivedSession[]> {
    const conn = server.current
    if (!conn) return []
    const ctx = global.ensureServerCtx(conn)
    try {
      const res: unknown = await ctx.sdk.client.experimental.session.list({
        directory,
        archived: true,
        roots: true,
        limit: 100,
      })
      // The SDK may hand back the array directly, a HeyApi { data } envelope, or a
      // paginated { data: { data } } — unwrap whichever we get.
      const pick = (value: unknown): unknown[] => {
        if (Array.isArray(value)) return value
        if (value && typeof value === "object" && "data" in value) return pick((value as { data: unknown }).data)
        return []
      }
      const rows = pick(res) as Array<{
        id: string
        title?: string
        directory: string
        parentID?: string
        time?: { archived?: number | null }
      }>
      return rows
        .filter((session) => typeof session.time?.archived === "number" && !session.parentID)
        .map((session) => ({
          id: session.id,
          title: session.title || language.t("command.session.new"),
          directory: session.directory,
        }))
    } catch {
      return []
    }
  }

  async function restoreSession(directory: string, sessionID: string) {
    const conn = server.current
    if (!conn) return
    const ctx = global.ensureServerCtx(conn)
    try {
      // The server clears the archived flag when sent `null`; the generated type
      // only allows `number | undefined`, so cast (undefined would be dropped by JSON).
      await ctx.sdk.client.session.update({ directory, sessionID, time: { archived: null as unknown as undefined } })
      setArchivedNonce((value) => value + 1)
      showToast({ title: "Session restored" })
    } catch (err) {
      showToast({ title: "Couldn’t restore session", description: (err as Error).message })
    }
  }

  async function deleteArchived(directory: string, sessionID: string) {
    if (!window.confirm("Delete this session permanently? This removes all its messages and history.")) return
    const conn = server.current
    if (!conn) return
    const ctx = global.ensureServerCtx(conn)
    try {
      await ctx.sdk.client.session.delete({ sessionID, directory })
      setArchivedNonce((value) => value + 1)
      showToast({ title: "Session deleted" })
    } catch (err) {
      showToast({ title: "Couldn’t delete session", description: (err as Error).message })
    }
  }

  const isPinned = (tab: Tab) => !!pins()[tabKey(tab)]
  const dotColor = (tab: Tab) => dotColors()[tabKey(tab)] ?? DOT_DEFAULT

  function togglePin(tab: Tab) {
    const id = tabKey(tab)
    setPins((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = true
      localStorage.setItem(PIN_KEY, JSON.stringify(next))
      return next
    })
  }

  function setDot(tab: Tab, color: string) {
    const id = tabKey(tab)
    setDotColors((prev) => {
      const next = { ...prev, [id]: color }
      localStorage.setItem(COLOR_KEY, JSON.stringify(next))
      return next
    })
  }

  async function copyId(tab: Tab) {
    const id = tab.type === "draft" ? tab.draftID : tab.sessionId
    try {
      await navigator.clipboard.writeText(id)
      showToast({ title: "ID copied" })
    } catch {
      showToast({ title: "Couldn’t copy ID" })
    }
  }

  async function commitRename(tab: Tab, value: string) {
    setRenaming(undefined)
    const title = value.trim()
    if (!title || tab.type !== "session") return
    const directory = tabDirectory(tab)
    const ctx = serverCtxFor(tab)
    if (!ctx || !directory) return
    try {
      await ctx.sdk.client.session.update({ directory, sessionID: tab.sessionId, title })
      tabs.rememberSessionInfo(tab, { title, directory } as unknown as Session)
    } catch (err) {
      showToast({ title: "Couldn’t rename session", description: (err as Error).message })
    }
  }

  // Truncate to one line with an ellipsis; on hover, smooth-scroll the name to
  // reveal the rest, then snap back.
  function marqueeEnter(event: MouseEvent & { currentTarget: HTMLElement }) {
    const el = event.currentTarget
    const max = el.scrollWidth - el.clientWidth
    if (max <= 1) return
    el.style.textOverflow = "clip"
    el.scrollTo({ left: max, behavior: "smooth" })
  }
  function marqueeLeave(event: MouseEvent & { currentTarget: HTMLElement }) {
    const el = event.currentTarget
    el.scrollTo({ left: 0, behavior: "smooth" })
    el.style.textOverflow = "ellipsis"
  }

  return (
    <aside
      data-component="caliber-sidebar"
      class="flex h-full w-52 shrink-0 flex-col overflow-hidden border-r border-[#ffffff0f] bg-[#0b0b0b] px-3 pb-3.5 text-[#a0a0a0] select-none"
      style={{ "font-family": FONT_MONO }}
      aria-label="Caliber"
    >
      {/* Window drag + macOS traffic-light clearance. */}
      <Show when={desktop()}>
        <div class={`-mx-3 shrink-0 [app-region:drag] ${mac() ? "h-7" : "h-2"}`} data-tauri-drag-region />
      </Show>

      <button
        type="button"
        onClick={newGame}
        disabled={busy() || !rootDirectory()}
        class="mt-1 w-full rounded-[5px] border border-[#ffffff1f] bg-[#242424] py-2 text-[10.5px] font-bold tracking-[.16em] text-[#dcdcdc] transition-colors hover:bg-[#2c2c2c] disabled:opacity-40"
      >
        NEW&nbsp;GAME
      </button>

      <div class="mx-1 mb-1.5 mt-4 text-[10px] tracking-[.24em] text-[#4f4f4f]">GAMES</div>

      <div class="mb-2 flex items-center gap-2 rounded-[5px] border border-[#ffffff14] bg-[#101010] px-2.5 py-1.5">
        <span class="text-[#454545]">/</span>
        <input
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="search"
          spellcheck={false}
          class="min-w-0 flex-1 border-none bg-transparent text-[12px] text-[#c6c6c6] outline-none placeholder:text-[#565656]"
          style={{ "font-family": FONT_MONO }}
        />
      </div>

      <div class="-mx-1 flex-1 overflow-y-auto px-1 no-scrollbar">
        <Show
          when={entries().length > 0}
          fallback={<div class="px-2 py-1.5 text-[12px] leading-relaxed text-[#565656]">No games yet — describe one to Caliber, or hit NEW GAME.</div>}
        >
          <For each={entries()}>
            {(entry) => {
              const open = () => isOpen(entry.directory)
              const sessions = () => {
                const list = tabsByDirectory().get(entry.directory) ?? []
                return [...list].sort((a, b) => (isPinned(b) ? 1 : 0) - (isPinned(a) ? 1 : 0))
              }
              const active = () => entry.directory === activeDirectory()
              const [archivedOpen, setArchivedOpen] = createSignal(false)
              const [archived] = createResource(
                () => (open() ? ([entry.directory, archivedNonce()] as const) : undefined),
                ([directory]) => loadArchived(directory),
                { initialValue: [] as ArchivedSession[] },
              )
              return (
                <div class="mb-0.5">
                  <button
                    type="button"
                    onClick={() => toggle(entry.directory)}
                    class="group/game flex w-full items-center gap-2 rounded-[6px] border-none bg-transparent px-2 py-1.5 text-left text-[12px] tracking-[.02em]"
                    classList={{ "text-[#e0e0e0]": active(), "text-[#a0a0a0]": !active() }}
                  >
                    <span
                      class="inline-block text-[9px] text-[#767676] transition-transform"
                      style={{ transform: `rotate(${open() ? 90 : 0}deg)` }}
                    >
                      ▸
                    </span>
                    <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</span>
                    <Show when={entry.game}>
                      <span
                        role="button"
                        tabIndex={0}
                        class="shrink-0 text-[10px] text-[#565656] opacity-0 transition-opacity hover:text-[#c6c6c6] group-hover/game:opacity-100"
                        title="Launch in arcade"
                        onClick={(event) => {
                          event.stopPropagation()
                          void launchGame(entry.directory)
                        }}
                      >
                        ▸play
                      </span>
                    </Show>
                    <span class="shrink-0 text-[10px] text-[#565656]">{sessions().length || ""}</span>
                  </button>

                  <Show when={open()}>
                    <div class="ml-[9px] mb-1 mt-[2px] flex flex-col gap-px border-l border-[#ffffff17] pl-[9px]">
                      <For each={sessions()}>
                        {(tab) => {
                          const isActive = () => tabKey(tab) === tabs.recentKey()
                          return (
                            <Show
                              when={renaming() !== tabKey(tab)}
                              fallback={
                                <input
                                  ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
                                  value={tabTitle(tab)}
                                  spellcheck={false}
                                  class="w-full rounded-[6px] border border-[#ffffff1f] bg-[#101010] px-2 py-1 text-[12px] text-[#dcdcdc] outline-none"
                                  style={{ "font-family": FONT_MONO }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") void commitRename(tab, event.currentTarget.value)
                                    else if (event.key === "Escape") setRenaming(undefined)
                                  }}
                                  onBlur={(event) => void commitRename(tab, event.currentTarget.value)}
                                />
                              }
                            >
                              <ContextMenu>
                                <ContextMenu.Trigger
                                  as="button"
                                  type="button"
                                  onClick={() => tabs.select(tab)}
                                  class="flex w-full items-center gap-2 rounded-[6px] border-none px-2 py-1 text-left text-[12px] tracking-[.02em] transition-colors"
                                  classList={{
                                    "bg-[#171717] text-[#dcdcdc]": isActive(),
                                    "bg-transparent text-[#8f8f8f] hover:text-[#c6c6c6]": !isActive(),
                                  }}
                                >
                                  <span
                                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{ "background-color": dotColor(tab) }}
                                  />
                                  <span
                                    class="block min-w-0 flex-1 overflow-hidden whitespace-nowrap [text-overflow:ellipsis]"
                                    onMouseEnter={marqueeEnter}
                                    onMouseLeave={marqueeLeave}
                                  >
                                    {tabTitle(tab)}
                                  </span>
                                  <Show when={isPinned(tab)}>
                                    <span class="shrink-0 text-[8px] tracking-[.1em] text-[#565656]">PIN</span>
                                  </Show>
                                </ContextMenu.Trigger>
                                <ContextMenu.Portal>
                                  <ContextMenu.Content class={MENU_CONTENT}>
                                    <Show when={tab.type === "session"}>
                                      <ContextMenu.Item class={MENU_ITEM} onSelect={() => setRenaming(tabKey(tab))}>
                                        <ContextMenu.ItemLabel>Rename</ContextMenu.ItemLabel>
                                      </ContextMenu.Item>
                                    </Show>
                                    <ContextMenu.Item class={MENU_ITEM} onSelect={() => togglePin(tab)}>
                                      <ContextMenu.ItemLabel>{isPinned(tab) ? "Unpin" : "Pin"}</ContextMenu.ItemLabel>
                                    </ContextMenu.Item>
                                    <ContextMenu.Sub>
                                      <ContextMenu.SubTrigger class={MENU_ITEM}>
                                        <span>Appearance</span>
                                        <span
                                          class="ml-auto h-2 w-2 shrink-0 rounded-full"
                                          style={{ "background-color": dotColor(tab) }}
                                        />
                                      </ContextMenu.SubTrigger>
                                      <ContextMenu.Portal>
                                        <ContextMenu.SubContent class={MENU_CONTENT}>
                                          <For each={DOT_COLORS}>
                                            {(color) => (
                                              <ContextMenu.Item
                                                class={MENU_ITEM}
                                                onSelect={() => setDot(tab, color.value)}
                                              >
                                                <span
                                                  class="h-2 w-2 shrink-0 rounded-full"
                                                  style={{ "background-color": color.value }}
                                                />
                                                <ContextMenu.ItemLabel>{color.label}</ContextMenu.ItemLabel>
                                              </ContextMenu.Item>
                                            )}
                                          </For>
                                        </ContextMenu.SubContent>
                                      </ContextMenu.Portal>
                                    </ContextMenu.Sub>
                                    <ContextMenu.Item class={MENU_ITEM} onSelect={() => void copyId(tab)}>
                                      <ContextMenu.ItemLabel>Copy ID</ContextMenu.ItemLabel>
                                    </ContextMenu.Item>
                                    <ContextMenu.Separator />
                                    <Show when={tab.type === "session"}>
                                      <ContextMenu.Item
                                        class={MENU_ITEM}
                                        onSelect={() => void archiveSession(tab as SessionTab)}
                                      >
                                        <ContextMenu.ItemLabel>Archive</ContextMenu.ItemLabel>
                                      </ContextMenu.Item>
                                    </Show>
                                    <ContextMenu.Item
                                      class={`${MENU_ITEM} text-[#e0696e]! data-[highlighted]:text-[#f08a8e]!`}
                                      onSelect={() => {
                                        if (tab.type === "session") void deleteSession(tab)
                                        else closeSession(tab)
                                      }}
                                    >
                                      <ContextMenu.ItemLabel>Delete</ContextMenu.ItemLabel>
                                    </ContextMenu.Item>
                                  </ContextMenu.Content>
                                </ContextMenu.Portal>
                              </ContextMenu>
                            </Show>
                          )
                        }}
                      </For>
                      <button
                        type="button"
                        onClick={() => newSessionIn(entry.directory)}
                        class="border-none bg-transparent px-2 py-1.5 text-left text-[11px] tracking-[.04em] text-[#616161] transition-colors hover:text-[#9a9a9a]"
                      >
                        + new session
                      </button>

                      <Show when={(archived() ?? []).length > 0}>
                        <button
                          type="button"
                          onClick={() => setArchivedOpen((value) => !value)}
                          class="mt-0.5 flex w-full items-center gap-2 border-none bg-transparent px-2 py-1 text-left text-[11px] tracking-[.06em] text-[#565656] transition-colors hover:text-[#8f8f8f]"
                        >
                          <span
                            class="inline-block text-[8px] transition-transform"
                            style={{ transform: `rotate(${archivedOpen() ? 90 : 0}deg)` }}
                          >
                            ▸
                          </span>
                          <span class="flex-1">archived</span>
                          <span class="text-[10px] text-[#454545]">{(archived() ?? []).length}</span>
                        </button>
                        <Show when={archivedOpen()}>
                          <For each={archived() ?? []}>
                            {(session) => (
                              <ContextMenu>
                                <ContextMenu.Trigger
                                  as="button"
                                  type="button"
                                  onClick={() => void restoreSession(session.directory, session.id)}
                                  class="flex w-full items-center gap-2 rounded-[6px] border-none px-2 py-1 text-left text-[12px] text-[#6a6a6a] opacity-80 transition-colors hover:text-[#9a9a9a] hover:opacity-100"
                                >
                                  <span class="h-1.5 w-1.5 shrink-0 rounded-full border border-[#565656]" />
                                  <span
                                    class="block min-w-0 flex-1 overflow-hidden whitespace-nowrap [text-overflow:ellipsis] line-through decoration-[#3a3a3a]"
                                    onMouseEnter={marqueeEnter}
                                    onMouseLeave={marqueeLeave}
                                  >
                                    {session.title}
                                  </span>
                                </ContextMenu.Trigger>
                                <ContextMenu.Portal>
                                  <ContextMenu.Content class={MENU_CONTENT}>
                                    <ContextMenu.Item
                                      class={MENU_ITEM}
                                      onSelect={() => void restoreSession(session.directory, session.id)}
                                    >
                                      <ContextMenu.ItemLabel>Restore</ContextMenu.ItemLabel>
                                    </ContextMenu.Item>
                                    <ContextMenu.Item
                                      class={`${MENU_ITEM} text-[#e0696e]! data-[highlighted]:text-[#f08a8e]!`}
                                      onSelect={() => void deleteArchived(session.directory, session.id)}
                                    >
                                      <ContextMenu.ItemLabel>Delete</ContextMenu.ItemLabel>
                                    </ContextMenu.Item>
                                  </ContextMenu.Content>
                                </ContextMenu.Portal>
                              </ContextMenu>
                            )}
                          </For>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </div>

      <div class="mt-auto flex flex-col gap-0.5 border-t border-[#ffffff0d] pt-3.5">
        <button
          type="button"
          onClick={openSettings}
          class="border-none bg-transparent px-1 py-[7px] text-left text-[12px] tracking-[.08em] text-[#828282] transition-colors hover:text-[#c6c6c6]"
        >
          SETTINGS
        </button>
        <button
          type="button"
          onClick={() => platform.openLink("https://github.com/anomalyco/opencode")}
          class="border-none bg-transparent px-1 py-[7px] text-left text-[12px] tracking-[.08em] text-[#828282] transition-colors hover:text-[#c6c6c6]"
        >
          GITHUB
        </button>
      </div>
    </aside>
  )
}
