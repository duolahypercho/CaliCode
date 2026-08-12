import { useEffect, useState } from "react";
import {
  approveProjectMcp,
  listMcpServersWithFingerprint,
  reloadMcp,
  setMcpEnabled,
  type McpServerReport,
} from "../../lib/extensions";
import { readCoreConfig, type McpServerConfigEntry } from "../../lib/coreConfig";

const STATUS_DOT: Record<McpServerReport["status"], string> = {
  running: "bg-emerald-400",
  failed: "bg-red-400",
  disabled: "bg-surface-3 border border-line-strong",
};

const BADGE =
  "shrink-0 rounded border border-line px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] text-ink-subtle";

/**
 * Settings panel body listing configured MCP servers (skills-mcp.md §4.4):
 * status dot per server (running green / failed red with the error / disabled
 * grey), transport + scope badges, tool count with an expandable
 * namespaced-tool list, the server's include/exclude tool filter (read-only),
 * an enable toggle per server and a RELOAD button that restarts them all from
 * config. Scope is derived by cross-referencing the global config: a running
 * server whose id is absent from ~/.cali/config.yaml came from the open
 * project's .cali/config.yaml.
 */
export function McpSection({ headingLevel = 3 }: { headingLevel?: 2 | 3 } = {}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const [servers, setServers] = useState<McpServerReport[] | null>(null);
  // Fingerprint of the project MCP config these rows describe, echoed back on
  // approve so consent cannot land on a config the user never saw.
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  // Global config entries, for the scope badge + tool-filter display. Null
  // until loaded (or on failure) — badges simply stay off then.
  const [globalEntries, setGlobalEntries] = useState<McpServerConfigEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMcpServersWithFingerprint()
      .then(({ servers: reports, projectFingerprint }) => {
        if (cancelled) return;
        setServers(reports);
        setFingerprint(projectFingerprint);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to list MCP servers.");
      });
    readCoreConfig()
      .then((config) => {
        if (!cancelled) setGlobalEntries(config.mcp_servers ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (op: () => Promise<McpServerReport[]>, failure: string) => {
    setBusy(true);
    setError("");
    try {
      setServers(await op());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="MCP servers" className="text-sm">
      <div className="flex items-center justify-between gap-2">
        <Heading className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">MCP servers</Heading>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(reloadMcp, "Failed to reload MCP servers.")}
          className="rounded border border-line px-2 py-[3px] text-[10px] tracking-[0.14em] text-ink-subtle transition-colors hover:text-ink-strong focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          RELOAD
        </button>
      </div>

      <ul className="mt-2.5 space-y-2">
        {servers === null ? (
          <li className="rounded-lg border border-line bg-surface-1 px-3 py-2.5 text-sm text-ink-subtle">
            Loading MCP servers…
          </li>
        ) : servers.length === 0 ? (
          <li className="rounded-lg border border-line bg-surface-1 px-3 py-2.5 text-xs leading-[1.7] text-ink-subtle">
            No MCP servers configured. Add entries under <span className="font-mono text-ink">mcp_servers</span> in{" "}
            <span className="font-mono text-ink">~/.cali/config.yaml</span> and hit RELOAD.
          </li>
        ) : (
          servers.map((server) => {
            const expanded = expandedId === server.id;
            // Scope: derived from the global config once it has loaded. A
            // server core is running that the global config doesn't declare
            // was merged in from the project's .cali/config.yaml.
            const globalEntry = globalEntries?.find((entry) => entry.id === server.id);
            // Core reports the scope authoritatively; the global-config
            // cross-reference is only the fallback for older cores.
            const scope =
              server.projectScoped === true
                ? "project"
                : server.projectScoped === false
                  ? "global"
                  : globalEntries === null
                    ? null
                    : globalEntry
                      ? "global"
                      : "project";
            const filter = globalEntry?.tools;
            const hasFilter = Boolean(filter && (filter.include.length > 0 || filter.exclude.length > 0));
            return (
              <li key={server.id} className="rounded-lg border border-line bg-surface-1 px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    title={server.status === "failed" ? server.error ?? "failed" : server.status}
                    className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[server.status]}`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-sm font-medium text-ink-strong">{server.id}</span>
                    <span className="ml-2 truncate font-mono text-xs text-ink-faint">
                      {server.transport === "http" ? server.url : server.command}
                    </span>
                  </span>
                  <span className={BADGE}>{server.transport || "stdio"}</span>
                  {scope ? (
                    <span
                      className={`${BADGE} ${scope === "project" ? "border-sky-500/40 bg-sky-500/10 text-sky-400" : ""}`}
                    >
                      {scope}
                    </span>
                  ) : null}
                  {server.trust ? (
                    <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] text-amber-400">
                      trusted
                    </span>
                  ) : null}
                  {server.status === "running" ? (
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : server.id)}
                      aria-expanded={expanded}
                      className="shrink-0 rounded border border-line px-1.5 py-[2px] text-[10px] text-ink-subtle transition-colors hover:text-ink-strong focus-visible:outline-none"
                    >
                      {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
                    </button>
                  ) : null}
                  {server.pendingConsent ? (
                    <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] text-amber-400">
                      blocked
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={`Enable MCP server ${server.id}`}
                      checked={server.status !== "disabled"}
                      disabled={busy}
                      onChange={(event) =>
                        void run(
                          () => setMcpEnabled(server.id, event.target.checked),
                          `Failed to toggle ${server.id}.`,
                        )
                      }
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--line-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  )}
                </div>

                {server.pendingConsent ? (
                  <div className="mt-1.5 flex items-start gap-2">
                    <p className="flex-1 text-[11px] leading-[1.6] text-ink-subtle">
                      This server is declared by the open project&rsquo;s{" "}
                      <span className="font-mono text-ink">.cali/config.yaml</span>, not by you. It stays blocked
                      until you approve it — check the command above before running code a repository chose.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => approveProjectMcp("", true, fingerprint),
                          `Failed to approve ${server.id}.`,
                        )
                      }
                      className="shrink-0 rounded border border-line px-2 py-[3px] text-[10px] uppercase tracking-[0.08em] text-ink-subtle transition-colors hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Approve
                    </button>
                  </div>
                ) : null}

                {server.status === "failed" && server.error ? (
                  <p className="mt-1 text-xs text-destructive">{server.error}</p>
                ) : null}

                {hasFilter && filter ? (
                  <p className="mt-1.5 text-[11px] leading-[1.6] text-ink-subtle">
                    <span className="uppercase tracking-[0.08em] text-ink-faint">tool filter</span>
                    {filter.include.length > 0 ? (
                      <span className="ml-2">
                        include: <span className="font-mono text-ink">{filter.include.join(", ")}</span>
                      </span>
                    ) : null}
                    {filter.exclude.length > 0 ? (
                      <span className="ml-2">
                        exclude: <span className="font-mono text-ink">{filter.exclude.join(", ")}</span>
                      </span>
                    ) : null}
                  </p>
                ) : null}

                {expanded && server.tools.length > 0 ? (
                  <ul className="mt-2 space-y-1 border-t border-line pt-2">
                    {server.tools.map((tool) => (
                      <li key={tool.namespaced} className="text-xs">
                        <span className="font-mono text-ink">{tool.namespaced}</span>
                        {tool.description ? (
                          <span className="ml-2 text-ink-subtle" title={tool.description}>
                            {tool.description}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })
        )}
      </ul>

      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <p className="mt-3 text-[11px] leading-[1.55] text-ink-faint">
        Servers are configured in ~/.cali/config.yaml under mcp_servers (stdio or http transport); a game folder's
        .cali/config.yaml can add project-scoped servers or override global ones by id. Per-server tools:{" "}
        {"{include, exclude}"} globs narrow what the agent sees. Untrusted servers require approval per tool call
        outside full-access mode.
      </p>
    </section>
  );
}
