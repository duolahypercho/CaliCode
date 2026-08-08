import { useEffect, useState } from "react";
import { devServerStatus, startDevServer, stopDevServer, type DevServerStatus } from "../../lib/workspace";

interface LivePreviewProps {
  workspaceId: string;
  workspaceName: string;
  script: string;
  onError: (message: string) => void;
}

const POLL_MS = 1500;

/**
 * Runs the workspace's own dev server and shows it in PLAY.
 *
 * The frame is cross-origin, so its console and DOM are not reachable from
 * here — reloads go through a key bump, and "Pop out" exists because
 * pointer-lock plus keyboard capture in a cross-origin frame is unreliable.
 */
export function LivePreview({ workspaceId, workspaceName, script, onError }: LivePreviewProps) {
  const [status, setStatus] = useState<DevServerStatus>({ workspaceId, status: "stopped" });
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      devServerStatus(workspaceId)
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId]);

  const start = async () => {
    setBusy(true);
    try {
      setStatus(await startDevServer(workspaceId, script));
    } catch (error) {
      onError(`dev server failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopDevServer(workspaceId);
      setStatus({ workspaceId, status: "stopped" });
    } finally {
      setBusy(false);
    }
  };

  const running = status.status === "ready" || status.status === "starting";

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.06] bg-[#0b0b0b] px-3.5">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 ${
            status.status === "ready"
              ? "animate-pulse bg-[#bdbdbd]"
              : status.status === "crashed"
                ? "bg-[#c98b8b]"
                : "bg-[#8a8a8a]"
          }`}
        />
        <span className="text-[10.5px] tracking-[0.14em] text-[#c0c0c0]">{status.status.toUpperCase()}</span>
        <span className="min-w-0 truncate text-[11px] text-[#8a8a8a]">
          {status.url ?? `${workspaceName} · ${script}`}
        </span>
        <div className="ml-auto flex shrink-0 gap-1.5">
          {status.status === "ready" ? (
            <>
              <button
                type="button"
                onClick={() => setNonce((n) => n + 1)}
                className="inline-flex min-h-[28px] items-center rounded border border-white/[0.12] px-2.5 py-1 text-[10px] tracking-[0.12em] text-[#d4d4d4] transition-colors hover:border-white/30 active:border-white/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
              >
                RELOAD
              </button>
              <a
                href={status.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-[28px] items-center rounded border border-white/[0.12] px-2.5 py-1 text-[10px] tracking-[0.12em] text-[#d4d4d4] transition-colors hover:border-white/30 active:border-white/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
              >
                POP OUT
              </a>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => void (running ? stop() : start())}
            disabled={busy}
            className={`inline-flex min-h-[28px] items-center rounded border border-white/[0.12] bg-[#2a2a2a] px-3 py-1 text-[10px] font-bold tracking-[0.12em] text-[#dcdcdc] transition-colors enabled:hover:bg-[#333] active:bg-[#3a3a3a] focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-40 ${
              running ? "focus-visible:ring-[#c06060]/50" : "focus-visible:ring-white/30"
            }`}
          >
            {running ? "STOP" : "START"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {status.status === "ready" && status.url ? (
          <iframe
            key={nonce}
            src={status.url}
            title={`${workspaceName} preview`}
            allow="fullscreen; pointer-lock; autoplay; microphone; xr-spatial-tracking"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-[#8f8f8f]">
            <span className="tracking-[0.14em]">
              {status.status === "starting"
                ? "STARTING THE DEV SERVER…"
                : status.status === "crashed"
                  ? "DEV SERVER DID NOT COME UP"
                  : "DEV SERVER STOPPED"}
            </span>
            <span>
              {workspaceName} · npm run {script}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
