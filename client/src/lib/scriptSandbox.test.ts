import { describe, expect, it } from "vitest";
import { createScriptSandbox, toSandboxEntity } from "./scriptSandbox";

/**
 * The sandbox exists because project scripts come from three untrusted
 * sources — agent output, project JSON loaded from disk, and imported `.cali`
 * assets — and used to be evaluated in the page realm, same origin as the
 * `/rpc` proxy.
 *
 * Under vitest/jsdom there is no Worker, so these exercise the inline runner
 * and therefore cover the *protocol* (patches in, patches out, errors
 * contained, no live three.js object crosses the boundary) rather than the
 * isolation itself, which is a property of the Worker.
 */

const entity = (overrides: Partial<{ x: number; scripts: string[] }> = {}) =>
  toSandboxEntity("e1", "Probe", overrides.scripts ?? ["s1"], {
    position: { x: overrides.x ?? 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });

const script = (code: string) => [{ id: "s1", name: "probe", code }];

describe("script sandbox", () => {
  it("returns a transform patch rather than mutating a live object", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script("function update(entity){ entity.position.x += 5; }"),
    });

    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].position.x).toBe(5);
    sandbox.dispose();
  });

  it("recompiles when the source changes", async () => {
    const sandbox = createScriptSandbox();
    const first = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script("function update(entity){ entity.position.x += 1; }"),
    });
    expect(first.patches[0].position.x).toBe(1);

    const second = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script("function update(entity){ entity.position.x += 100; }"),
    });
    expect(second.patches[0].position.x).toBe(100);
    sandbox.dispose();
  });

  it("contains a throwing script and reports it", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script("function update(){ throw new Error('boom'); }"),
    });

    expect(result.logs.join("\n")).toContain("boom");
    expect(result.patches).toHaveLength(1);
    sandbox.dispose();
  });

  it("passes the simulation clock through as state.time", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 2.5,
      entities: [entity()],
      scripts: script("function update(entity, state){ entity.position.x = state.time; }"),
    });

    expect(result.patches[0].position.x).toBe(2.5);
    sandbox.dispose();
  });

  it("exposes entity names, not scene objects", async () => {
    // state.entities used to be `scene.children` — live three.js objects with
    // full renderer reach. Scripts now only learn the names.
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script(
        "function update(entity, state){ entity.position.x = Array.isArray(state.entities) ? state.entities.length : -1; }",
      ),
    });

    expect(result.patches[0].position.x).toBe(1);
    sandbox.dispose();
  });

  it("skips entities whose script is missing", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity({ scripts: ["does-not-exist"] })],
      scripts: script("function update(entity){ entity.position.x += 5; }"),
    });

    expect(result.patches[0].position.x).toBe(0);
    expect(result.logs).toHaveLength(0);
    sandbox.dispose();
  });

  it("carries no reference to the DOM across the boundary", async () => {
    // The payload must be structured-clonable; anything holding a DOM node or
    // a three.js object would throw once a real Worker is in play.
    const payload = {
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script("function update(){}"),
    };
    expect(() => structuredClone(payload)).not.toThrow();
  });
});
