import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { connectEvents, rpc, type AgentEvent } from "../../lib/rpc";

interface TerminalTabProps {
  projectSlug: string;
  /** Repaint and refit when the theme flips; xterm colours are set at runtime. */
  theme?: "dark" | "light";
}

interface OpenedSession {
  sessionId: string;
  cwd: string;
  shell: string;
  /**
   * Set when the game's folder was refused. macOS withholds Desktop/Documents/
   * Downloads from binaries without the grant, and `/bin/zsh` is not the signed
   * bundle — a shell started there blocks forever inside `getcwd()` rather than
   * failing, so core starts elsewhere instead of handing over a dead shell.
   */
  cwdFallbackFrom?: string;
}

/** xterm renders on a canvas, so its colours cannot come from CSS tokens. */
const THEMES = {
  dark: {
    background: "#0a0a0a",
    foreground: "#bdbdbd",
    cursor: "#e6e6e6",
    selectionBackground: "#2e2e2e",
    black: "#0a0a0a",
    brightBlack: "#6a6a6a",
    white: "#bdbdbd",
    brightWhite: "#e6e6e6",
  },
  light: {
    background: "#ffffff",
    foreground: "#3d3d3d",
    cursor: "#1a1a1a",
    selectionBackground: "#e2e2e0",
    black: "#1a1a1a",
    brightBlack: "#9b9b9b",
    white: "#3d3d3d",
    brightWhite: "#1a1a1a",
  },
} as const;

/**
 * A real terminal: a persistent shell in a PTY, rendered by xterm.
 *
 * The PTY is what makes `cd` stick between commands, makes programs emit
 * colour because they detect a TTY, and lets interactive things — a REPL,
 * vim, a password prompt — actually work. It is the operator's own shell with
 * the reach they already have in Terminal.app, and is deliberately reachable
 * only from this panel: it is not an agent tool.
 */
export function TerminalTab({ projectSlug, theme = "dark" }: TerminalTabProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const openingRef = useRef(false);
  const [status, setStatus] = useState<"opening" | "ready" | "fallback" | "closed" | "failed">("opening");
  const [detail, setDetail] = useState<string>("");
  const [cwd, setCwd] = useState<string>("");

  // Mount once. A remount would orphan the shell, so the session is opened
  // here and closed only on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: THEMES[theme],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Keystrokes go to the PTY verbatim — control characters and escape
    // sequences included, which is what makes Ctrl-C and the arrow keys work.
    term.onData((data) => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      void rpc("terminal_input", { sessionId, data }).catch(() => {
        // A dead session surfaces through terminal.closed; a failed keystroke
        // is not worth a dialog.
      });
    });


    return () => {
      disposed = true;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Output arrives on the shared bus; only this session's bytes are written.
  useEffect(() => {
    let disposed = false;
    const openSession = async () => {
      // Guarded because a dropped SSE connection re-fires onOpen, and a second
      // shell per reconnect would leak processes.
      if (disposed || sessionRef.current || openingRef.current) return;
      openingRef.current = true;
      try {
        const opened = await rpc<OpenedSession>("terminal_open", {
          projectSlug,
          cols: termRef.current?.cols ?? 80,
          rows: termRef.current?.rows ?? 24,
        });
        if (disposed) {
          void rpc("terminal_close", { sessionId: opened.sessionId }).catch(() => {});
          return;
        }
        sessionRef.current = opened.sessionId;
        setStatus(opened.cwdFallbackFrom ? "fallback" : "ready");
        setDetail(opened.cwdFallbackFrom ?? opened.cwd);
        setCwd(opened.cwd);
      } catch (error) {
        if (!disposed) {
          setStatus("failed");
          setDetail(error instanceof Error ? error.message : String(error));
        }
      } finally {
        openingRef.current = false;
      }
    };
    const disconnect = connectEvents((event: AgentEvent) => {
      if (!event.sessionId || event.sessionId !== sessionRef.current) return;
      if (event.type === "terminal.data" && typeof event.data === "string") {
        termRef.current?.write(event.data);
      }
      if (event.type === "terminal.closed") {
        sessionRef.current = null;
        setStatus("closed");
        termRef.current?.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
      }
    }, openSession);
    return () => {
      disposed = true;
      disconnect();
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      if (sessionId) void rpc("terminal_close", { sessionId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The dock is resizable and the tab can go full screen, so the PTY has to be
  // told its new size or full-screen programs redraw against stale dimensions.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      const sessionId = sessionRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        // fit throws while the host is display:none (an inactive tab).
        return;
      }
      if (sessionId) {
        void rpc("terminal_resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = THEMES[theme];
  }, [theme]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0">
      <div
        ref={hostRef}
        data-terminal-host
        onClick={() => termRef.current?.focus()}
        className="min-h-0 flex-1 overflow-hidden px-2 py-1.5"
      />
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5 text-[10.5px] text-ink-faint">
        {status === "fallback" ? (
          <span className="text-danger-soft">
            Started in {cwd} — CaliCode cannot read {detail}. Grant access in System Settings › Privacy &amp;
            Security › Files and Folders.
          </span>
        ) : status === "failed" ? (
          <span className="text-danger-soft">terminal unavailable — {detail}</span>
        ) : status === "closed" ? (
          <span>session ended — reopen the tab to start a new shell</span>
        ) : status === "opening" ? (
          <span>starting shell…</span>
        ) : (
          <span className="truncate">{detail}</span>
        )}
      </div>
    </div>
  );
}
