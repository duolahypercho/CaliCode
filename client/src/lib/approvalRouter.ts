/**
 * Who owns an approval prompt, and what a card may do next.
 *
 * This module imports nothing, and a test asserts that it imports nothing.
 * That is the point of it: nine rounds of approval bugs all came from
 * ownership being *inferred* from local state — sets of session ids the panel
 * happened to have seen, graphs it remembered starting, whether a turn was
 * still running — and every one of those inputs had to live somewhere the
 * decision could reach. Here there is nowhere to put one and no way to reach
 * any. If a fix needs an import, the fix belongs in a different file.
 *
 * The invariant this exists to serve:
 *
 * > Only two things may produce a denial — a human clicking Deny, or core's
 * > own bounded timer. No inference, no transport failure, no state
 * > transition, on either side, ever.
 */

/** The fields `route` is allowed to see. Deliberately narrow. */
export type RoutableApproval = {
  /**
   * The one window core addressed this at. Present (possibly `null`) on every
   * prompt from a current core. Absent means a core older than this change.
   */
  targetClientId?: string | null;
  /** Display, and the legacy fallback below. Never a routing input otherwise. */
  ownerSession?: unknown;
};

export type RouterIdentity = {
  /** This window's id — the one `editor_attach` registered. */
  clientId: string | null;
  /** This panel's session, used only by the legacy fallback. */
  sessionId: string | null;
};

export type Route = "mine" | "not-mine";

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decide whether this panel owns a prompt.
 *
 * A routed token is authoritative and never falls through — the exact rule
 * `ownsBrowserToolEvent` already uses for `agent.tool_request`. Falling
 * through on a mismatch is what round 3 did, and it is why a stamp without an
 * enforced address is decoration.
 *
 * One permitted observation, which must never become an input: in dev builds
 * it is worth logging when a prompt arrives addressed at nobody while this
 * panel has a live run, because that means `editor_attach` did not land. It
 * logs. It must never route. The last three rounds each turned an observation
 * into an input.
 */
export function route(event: RoutableApproval, identity: RouterIdentity): Route {
  if ("targetClientId" in event) {
    const target = event.targetClientId;
    return typeof target === "string" && target.length > 0 && target === identity.clientId
      ? "mine"
      : "not-mine";
  }

  // Field absent: a core older than the addressing change. Only reachable in
  // development — core ships inside the Tauri binary — so fall back to the
  // owner stamp rather than showing the user nothing.
  const owner = nonEmptyString(event.ownerSession);
  if (owner === null || identity.sessionId === null) return "not-mine";
  return owner === identity.sessionId ? "mine" : "not-mine";
}

/**
 * How a failed `agent_approval_response` should be treated.
 *
 * Total, and the default is on the safe side. Only core's own refusal strings
 * are whitelisted; a transport error, an empty message, or anything
 * unrecognised means "we do not know", and not knowing must leave the card up
 * rather than throw it away. The cost of being wrong in the `retry` direction
 * is one extra click; the cost of being wrong the other way is a destroyed
 * node.
 *
 * Exactly one call site, by rule. The `/loop` completion gate keeps its own
 * predicate under its own name — two narrow predicates that cannot be
 * confused, which is defect 6's real lesson.
 */
export type SendFailure = "retry" | "gone" | "not-yours";

export function classifySendFailure(error: unknown): SendFailure {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/no pending approval/i.test(message)) return "gone";
  if (/session .*not found/i.test(message)) return "gone";
  if (/belongs to another CaliCode window/i.test(message)) return "not-yours";
  if (/has no attached window/i.test(message)) return "not-yours";
  return "retry";
}
