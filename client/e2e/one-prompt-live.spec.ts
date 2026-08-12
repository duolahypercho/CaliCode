import { expect, test, type Page, type TestInfo } from "@playwright/test";

const LOOP_TIMEOUT_MS = 45 * 60_000;
const VIEWPORT = { width: 1440, height: 900 };
const LIVE_PROVIDER = process.env.CALI_LIVE_PROVIDER ?? "codex-router";
const LIVE_MODEL = process.env.CALI_LIVE_MODEL ?? "gpt-5.6-luna";
const LIVE_EFFORT = process.env.CALI_LIVE_EFFORT ?? (LIVE_MODEL.includes("minimax") ? "high" : "max");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type RpcResponse<T> = {
  result?: T;
  error?: { message?: string };
};

type Project = {
  slug: string;
  title: string;
  entities: unknown[];
  assets: unknown[];
  scripts: unknown[];
  tests: unknown[];
};

type GraphSummary = {
  graphId: string;
  projectSlug?: string | null;
  status: string;
  updatedAt: string;
};

type GraphNode = {
  id: string;
  kind: "build" | "judge";
  role: string;
  deps: string[];
  status: string;
  score?: number | null;
  threshold?: number | null;
  evidenceCount?: number;
  evidencePaths?: string[];
};

type Graph = GraphSummary & {
  goal: string;
  ownerSession?: string | null;
  workspaceRoot?: string | null;
  reasoningEffort?: string | null;
  nodes: GraphNode[];
};

type SessionSummary = {
  id: string;
  title: string;
  projectSlug?: string | null;
  messageCount?: number;
};

type LoopReport = {
  report: {
    status: string;
    iterations: Array<{
      outcome: string;
      agents: unknown[];
      checks: Array<{ kind: string; status: string }>;
      evidence: Array<{ kind: string; path: string }>;
      scores: Array<{ score: number; passThreshold?: number | null }>;
    }>;
    totals: {
      iterations: number;
      latestScorePercent?: number | null;
    };
  };
  htmlPath: string;
};

async function callRpc<T = unknown>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    async ({ rpcMethod, rpcParams }) => {
      const response = await fetch("/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: rpcMethod,
          params: rpcParams,
        }),
      });
      const envelope = (await response.json()) as RpcResponse<T>;
      if (!response.ok || envelope.error) {
        throw new Error(envelope.error?.message ?? `RPC ${rpcMethod} failed`);
      }
      return envelope.result as T;
    },
    { rpcMethod: method, rpcParams: params },
  );
}

async function projectRow(page: Page, title: string) {
  const row = page
    .locator("aside")
    .first()
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}$`) })
    .first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

async function openProjectAfterReload(page: Page, title: string) {
  const row = await projectRow(page, title);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
}

async function newestSessionForProject(page: Page, slug: string): Promise<SessionSummary> {
  let session: SessionSummary | undefined;
  await expect
    .poll(
      async () => {
        const sessions = await callRpc<SessionSummary[]>(page, "session_list", {});
        session = sessions.find((candidate) => candidate.projectSlug === slug);
        return Boolean(session);
      },
      { timeout: 30_000, intervals: [250, 500, 1_000, 2_000] },
    )
    .toBe(true);
  if (!session) throw new Error(`session_list did not return a session for ${slug}`);
  return session;
}

async function freshGraphs(page: Page, slug: string, baselineIds: Set<string>): Promise<Graph[]> {
  const listed = await callRpc<{ graphs: GraphSummary[] }>(page, "graph_list", { slug });
  const candidates = listed.graphs.filter((graph) => !baselineIds.has(graph.graphId));
  return Promise.all(candidates.map((summary) => callRpc<Graph>(page, "graph_status", { graphId: summary.graphId })));
}

function passingGraph(graph: Graph, projectSlug: string, session: SessionSummary): boolean {
  if (graph.projectSlug !== projectSlug || graph.ownerSession !== session.id || graph.status !== "complete") return false;
  const buildNodes = graph.nodes.filter((node) => node.kind === "build");
  const rootBuildNodes = buildNodes.filter((node) => node.deps.length === 0);
  const rootIds = new Set(rootBuildNodes.map((node) => node.id));
  const integrationNodes = buildNodes.filter(
    (node) =>
      node.deps.length >= rootBuildNodes.length &&
      rootBuildNodes.length >= 3 &&
      [...rootIds].every((rootId) => node.deps.includes(rootId)),
  );
  const judgeNodes = graph.nodes.filter((node) => node.kind === "judge");
  return (
    buildNodes.length >= 4 &&
    rootBuildNodes.length >= 3 &&
    new Set(rootBuildNodes.map((node) => node.role)).size >= 3 &&
    integrationNodes.length >= 1 &&
    graph.nodes.every((node) => node.status === "passed") &&
    judgeNodes.some(
      (node) =>
        integrationNodes.some((integration) => node.deps.includes(integration.id)) &&
        (node.score ?? -1) >= (node.threshold ?? 90),
    ) &&
    buildNodes.some((node) => (node.evidenceCount ?? 0) >= 3 && (node.evidencePaths?.length ?? 0) > 0)
  );
}

test.describe("one-prompt live production proof @live", () => {
  test.use({ viewport: VIEWPORT });

  test("builds a game through the full loop with graph fanout, visual evidence, and durable resume @live", async ({ page }, testInfo: TestInfo) => {
    test.setTimeout(LOOP_TIMEOUT_MS);

    // Keep the effort picker deterministic even when models.dev is offline;
    // the provider request is still real and is asserted below. Luna/max is
    // the default; MiniMax/high is the supported fallback for a capped Luna
    // subscription and must satisfy this same proof unchanged.
    await page.addInitScript(({ model, effort }) => {
      localStorage.setItem(
        "calicode-modeldev-v2",
        JSON.stringify({
          at: Date.now(),
          index: { [model]: [effort] },
          catalog: {},
        }),
      );
      localStorage.setItem("calicode-model-effort-map", JSON.stringify({ [model]: effort }));
    }, { model: LIVE_MODEL, effort: LIVE_EFFORT });

    const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    const slug = `live-one-prompt-${suffix}`;
    const title = `Live one prompt ${suffix}`;
    const goal = [
      `Build a polished, playable disposable mini-game named Neon Relay in ${title}.`,
      "This is a strict live acceptance run, not a prose exercise.",
      "The internal orchestration is mandatory: call loop_report_start, then graph_plan with at least five nodes.",
      "The graph must have three dependency-free build roots with distinct roles covering gameplay/entities, procedural assets/materials/lighting, and scripts/tests. Add a separate integration build node that depends on every root, then a fresh terminal judge that depends on integration. Use graph_run and fresh subagents for every graph node.",
      "Create real project changes: add a gameplay arena and collectible/goal entities, add at least one new procedural asset and use it, write at least one new gameplay script, and add at least one new automated test.",
      "Run the game in PIE for at least 60 frames. Persist at least three different moments directly with editor_persist_capture(path) under reports/loops/<loop-id>/<iteration>/; do not copy screenshot dataUrls or use UTF-8 file_write for images. Read editor_console_history and require zero error entries. Call editor_analyze_motion and include its returned PNG/manifest paths plus the individual persisted frame paths in the graph/report. Run editor_run_tests and require every test to pass.",
      "Record structured loop_report_iteration evidence after an initial pass and after a repair/review pass (at least two iterations total), including build/play/test checks, changed files, visual evidence, judge scores, and nextIterationMemory. The final fresh judge must score at least 90/100 against a named reference.",
      "Keep iterating on rejected nodes and judge punch-list items until the graph is complete, every node is passed, the report status is completed, and the final proof is durable. Only then reply with exactly DONE on its own line.",
    ].join(" ");

    const agentRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/rpc") || request.method() !== "POST") return;
      try {
        const body = request.postDataJSON() as { method?: string; params?: Record<string, unknown> };
        if (body.method && body.params) agentRequests.push({ method: body.method, params: body.params });
      } catch {
        // Ignore non-JSON requests; the app only sends JSON-RPC for this proof.
      }
    });

    let sessionId: string | null = null;
    let projectCreated = false;
    try {
      await page.goto("/");

      const baseline = await callRpc<Project>(page, "project_create", {
        slug,
        title,
        template: "starter",
      });
      projectCreated = true;
      expect(baseline.entities.length).toBeGreaterThan(0);

      await callRpc<{ active: { provider: string; model: string } }>(page, "model_switch", {
        provider: LIVE_PROVIDER,
        model: LIVE_MODEL,
      });

      await page.reload();
      await (await projectRow(page, title)).click();
      const activeModel = page.getByLabel("Active model");
      await expect(activeModel).toHaveAttribute(
        "title",
        new RegExp(`${escapeRegExp(LIVE_PROVIDER)}.*${escapeRegExp(LIVE_MODEL)}.*${escapeRegExp(LIVE_EFFORT)}`, "i"),
        { timeout: 30_000 },
      );

      const graphBefore = await callRpc<{ graphs: GraphSummary[] }>(page, "graph_list", { slug });
      const baselineGraphIds = new Set(graphBefore.graphs.map((graph) => graph.graphId));
      const prompt = page.getByLabel("Agent prompt");
      await prompt.fill(`/loop ${goal}`);
      await prompt.press("Enter");

      // The row must advertise the actual session that is running, even while
      // the user remains on the project and the model is still working.
      await expect(page.getByTestId("session-running-spinner")).toBeVisible({ timeout: 60_000 });

      await expect
        .poll(
          () => agentRequests.some(({ method, params }) => method === "agent_chat" && params.effort === LIVE_EFFORT),
          { timeout: 60_000 },
        )
        .toBe(true);
      expect(agentRequests.some(({ method, params }) => method === "agent_chat" && params.permissionMode === "full-access")).toBe(
        true,
      );
      expect(agentRequests.some(({ method, params }) => method === "agent_chat" && params.maxTurns === 20)).toBe(true);

      await expect(page.locator('[data-role="tool"]').filter({ hasText: /✔ loop complete in/ })).toBeVisible({
        timeout: LOOP_TIMEOUT_MS,
      });
      await expect(page.getByTestId("session-running-spinner")).toHaveCount(0, { timeout: 30_000 });

      const session = await newestSessionForProject(page, slug);
      sessionId = session.id;
      const loaded = await callRpc<{
        projectSlug?: string;
        workspaceRoot?: string | null;
        messages?: Array<{ role?: string; content?: string }>;
      }>(page, "session_load", { id: session.id });
      expect(loaded.projectSlug).toBe(slug);
      expect(loaded.messages?.some((message) => message.role === "user" && message.content?.includes("Neon Relay"))).toBe(true);
      expect(loaded.messages?.some((message) => message.role === "assistant" && /\bDONE\b/i.test(message.content ?? ""))).toBe(true);

      let graph: Graph | undefined;
      await expect
        .poll(
          async () => {
            const graphs = await freshGraphs(page, slug, baselineGraphIds);
            graph = graphs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
            return Boolean(graph);
          },
          { timeout: 45_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(true);
      if (!graph) throw new Error(`no fresh graph persisted for ${slug}`);
      expect(graph.reasoningEffort).toBe(LIVE_EFFORT);
      expect(passingGraph(graph, slug, session)).toBe(true);

      await expect
        .poll(
          async () => {
            const project = await callRpc<Project>(page, "project_open", { slug });
            return project.slug === slug && project.title === title;
          },
          { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(true);
      const persisted = await callRpc<Project>(page, "project_open", { slug });
      expect(persisted.entities.length).toBeGreaterThan(baseline.entities.length);
      expect(persisted.assets.length).toBeGreaterThan(baseline.assets.length);
      expect(persisted.scripts.length).toBeGreaterThan(baseline.scripts.length);
      expect(persisted.tests.length).toBeGreaterThan(baseline.tests.length);

      const reportsTab = page.getByRole("tab", { name: "reports", exact: true });
      await reportsTab.click();
      const reportsPanel = page.locator("#workspace-panel-reports");
      await expect(reportsPanel.getByText(goal, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(reportsPanel.getByText("Completed", { exact: true })).toBeVisible({ timeout: 30_000 });
      const listedReports = await callRpc<{ reports: Array<{ loopId: string; status: string }> }>(page, "loop_report_list", { slug });
      const completedSummary = listedReports.reports.find((report) => report.status === "completed");
      expect(completedSummary).toBeTruthy();
      const report = await callRpc<LoopReport>(page, "loop_report_open", {
        slug,
        loopId: completedSummary?.loopId,
      });
      expect(report.report.status).toBe("completed");
      expect(report.report.totals.iterations).toBeGreaterThanOrEqual(2);
      expect(report.report.totals.latestScorePercent ?? 0).toBeGreaterThanOrEqual(90);
      expect(report.report.iterations.some((iteration) => iteration.outcome === "passed")).toBe(true);
      expect(
        report.report.iterations.some((iteration) =>
          iteration.checks.some((check) => check.kind === "play" && check.status === "passed"),
        ),
      ).toBe(true);
      expect(
        report.report.iterations.some((iteration) =>
          iteration.checks.some((check) => check.kind === "test" && check.status === "passed"),
        ),
      ).toBe(true);
      expect(
        report.report.iterations.some((iteration) =>
          iteration.evidence.some((evidence) => evidence.path && /screenshot|contact|video/i.test(evidence.kind)),
        ),
      ).toBe(true);
      expect(report.htmlPath).toMatch(/^reports\/loops\/[^/]+\/report\.html$/);

      // A fresh browser load must recover both the project and the saved chat,
      // not merely leave the in-memory loop transcript visible.
      await page.reload();
      await openProjectAfterReload(page, title);
      const savedSession = page
        .locator("aside")
        .first()
        .getByRole("button", { name: new RegExp(`^${escapeRegExp(session.title)}`) })
        .first();
      await expect(savedSession).toBeVisible({ timeout: 30_000 });
      await savedSession.click();
      await expect(page.locator('[data-role="user"]').filter({ hasText: "Neon Relay" }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('[data-role="assistant"]').filter({ hasText: /\bDONE\b/i }).last()).toBeVisible({
        timeout: 30_000,
      });
      await page.getByRole("tab", { name: "reports", exact: true }).click();
      await expect(page.locator("#workspace-panel-reports").getByText("Completed", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      const stop = page.getByRole("button", { name: "Stop agent loop" });
      if (await stop.isVisible().catch(() => false)) {
        await stop.click().catch(() => undefined);
        await expect(stop).toBeHidden({ timeout: 20_000 }).catch(() => undefined);
      }
      if (sessionId) await callRpc(page, "session_delete", { id: sessionId }).catch(() => undefined);
      if (projectCreated) await callRpc(page, "project_delete", { slug }).catch(() => undefined);
    }
  });
});
