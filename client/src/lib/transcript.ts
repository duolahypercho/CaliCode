const DEFAULT_TRANSCRIPT_CHARS = 8000;

function labelFor(entry: { role: string; tool?: string }): string {
  const role = entry.role.trim().toLowerCase() || "message";
  const tool = entry.tool?.trim();
  // Tool entries carry their source so a claim and a command result remain
  // distinguishable after the transcript is flattened to text.
  return tool ? `${role}(${tool})` : role;
}

/** Drop the head of an over-long entry while retaining its source label. */
function truncateFront(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const separator = line.indexOf(": ");
  const label = separator > 0 ? line.slice(0, separator + 2) : "";
  const budget = limit - label.length - 1;
  if (budget <= 0) return line.slice(line.length - limit);
  return `${label}…${line.slice(line.length - budget)}`;
}

export interface TranscriptWindow {
  text: string;
  /** Entries that made the excerpt. */
  kept: number;
  /** Non-empty entries that could have made it. */
  total: number;
  /** True when an entry was dropped or its head was clipped. */
  truncated: boolean;
}

/**
 * Build a labelled, newest-first-budgeted excerpt while preserving the
 * original order of everything retained.
 */
export function buildTranscriptWindow(
  messages: Array<{ role: string; content: string; tool?: string }>,
  maxChars = DEFAULT_TRANSCRIPT_CHARS,
): TranscriptWindow {
  const total = messages.filter((entry) => entry.content?.trim()).length;
  const limit = Math.floor(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { text: "", kept: 0, total, truncated: total > 0 };
  }
  const kept: string[] = [];
  let used = 0;
  let clipped = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    const content = entry.content?.trim();
    if (!content) continue;
    const line = `${labelFor(entry)}: ${content}`;
    const cost = kept.length ? line.length + 1 : line.length;
    if (used + cost <= limit) {
      kept.unshift(line);
      used += cost;
      continue;
    }
    if (!kept.length) {
      kept.push(truncateFront(line, limit));
      clipped = true;
    }
    break;
  }
  return { text: kept.join("\n"), kept: kept.length, total, truncated: clipped || kept.length < total };
}
