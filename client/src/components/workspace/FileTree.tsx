import { useCallback, useEffect, useState } from "react";
import { readTree, type FileNode } from "../../lib/workspace";

interface FileTreeProps {
  workspaceId: string;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onError: (message: string) => void;
}

/**
 * Lazy file tree over a live workspace. Directories load one level per
 * expansion — the San Francisco repo's `public/data` alone is ~410MB, so a
 * recursive walk would stall the pane.
 */
export function FileTree({ workspaceId, activePath, onOpenFile, onError }: FileTreeProps) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [children, setChildren] = useState<Record<string, FileNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readTree(workspaceId, "", 1)
      .then((result) => {
        if (!cancelled) setRoots(result.entries);
      })
      .catch((error: unknown) => onError(`file tree failed: ${describe(error)}`))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, onError]);

  const toggle = useCallback(
    async (node: FileNode) => {
      const next = new Set(expanded);
      if (next.has(node.path)) {
        next.delete(node.path);
        setExpanded(next);
        return;
      }
      next.add(node.path);
      setExpanded(next);
      if (children[node.path]) return;
      try {
        const result = await readTree(workspaceId, node.path, 1);
        setChildren((current) => ({ ...current, [node.path]: result.entries }));
      } catch (error) {
        onError(`cannot open ${node.path}: ${describe(error)}`);
      }
    },
    [children, expanded, onError, workspaceId],
  );

  const renderNodes = (nodes: FileNode[], depth: number) =>
    nodes.map((node) => {
      const open = expanded.has(node.path);
      const active = node.path === activePath;
      return (
        <div key={node.path}>
          <button
            type="button"
            onClick={() => (node.kind === "dir" ? void toggle(node) : onOpenFile(node.path))}
            aria-expanded={node.kind === "dir" ? open : undefined}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={`flex w-full items-center gap-1.5 rounded py-[5px] pr-2 text-left text-[12px] ${
              active ? "bg-[#171717] text-[#dcdcdc]" : "text-[#8f8f8f] hover:text-[#c6c6c6]"
            }`}
          >
            <span aria-hidden className="w-2.5 shrink-0 text-[9px] text-[#565656]">
              {node.kind === "dir" ? (open ? "▾" : "▸") : ""}
            </span>
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </button>
          {node.kind === "dir" && open ? renderNodes(children[node.path] ?? [], depth + 1) : null}
        </div>
      );
    });

  return (
    <div className="h-full overflow-y-auto py-2">
      <div className="calicode-label px-3 pb-2">Files</div>
      {loading ? (
        <p className="px-3 text-xs text-[#565656]">Loading…</p>
      ) : roots.length === 0 ? (
        <p className="px-3 text-xs text-[#565656]">Nothing to show.</p>
      ) : (
        renderNodes(roots, 0)
      )}
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
