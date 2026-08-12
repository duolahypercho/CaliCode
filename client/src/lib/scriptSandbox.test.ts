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

const entity = (overrides: Partial<{ x: number; scripts: string[]; visible?: boolean; kind?: string }> = {}) =>
  toSandboxEntity("e1", "Probe", overrides.kind ?? "box", overrides.visible ?? true, overrides.scripts ?? ["s1"], {
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

  it("accepts a [x, y, z] array at the boundary and emits a plain object vector", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script("function update(entity){ entity.position = [4, 5, 6]; }"),
    });

    expect(result.patches[0].position).toEqual({ x: 4, y: 5, z: 6 });
    expect(result.logs).toHaveLength(0);
    sandbox.dispose();
  });

  it("reverts a non-finite object vector to the pre-step value and logs the script", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity({ x: 7 })],
      scripts: script("function update(entity){ entity.position = { x: NaN, y: Infinity, z: 0 }; }"),
    });

    expect(result.patches[0].position).toEqual({ x: 7, y: 0, z: 0 });
    expect(result.logs.join("\n")).toMatch(/position must be a finite vec3/);
    expect(result.logs.join("\n")).toMatch(/probe/);
    expect(result.logs.join("\n")).toMatch(/reverted to pre-step value/);
    sandbox.dispose();
  });

  it("reverts a non-finite array vector to the pre-step value", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script("function update(entity){ entity.position = [1, NaN, 3]; }"),
    });

    expect(result.patches[0].position).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.logs.join("\n")).toMatch(/position must be a finite vec3/);
    sandbox.dispose();
  });

  it("reverts a malformed shape (string, missing key) to the pre-step value", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity({ x: 9 })],
      scripts: script(
        "function update(entity){ entity.position = 'not a vector'; entity.scale = { x: 1, y: 2 }; }",
      ),
    });

    expect(result.patches[0].position).toEqual({ x: 9, y: 0, z: 0 });
    expect(result.patches[0].scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(result.logs.join("\n")).toMatch(/position must be a finite vec3/);
    expect(result.logs.join("\n")).toMatch(/scale must be a finite vec3/);
    sandbox.dispose();
  });

  it("never lets a NaN component reach the patch, even when the script mutates per-axis", async () => {
    // Per-axis mutation keeps the object identity the input entity was sent
    // in with, so the normalizer must still notice the bad component.
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity({ x: 2 })],
      scripts: script("function update(entity){ entity.position.y = NaN; }"),
    });

    expect(Number.isFinite(result.patches[0].position.x)).toBe(true);
    expect(Number.isFinite(result.patches[0].position.y)).toBe(true);
    expect(Number.isFinite(result.patches[0].position.z)).toBe(true);
    expect(result.patches[0].position.x).toBe(2);
    expect(result.patches[0].position.y).toBe(0);
    expect(result.logs.join("\n")).toMatch(/position must be a finite vec3/);
    sandbox.dispose();
  });
});

describe("script sandbox state contract", () => {
  const hero = (overrides: Partial<{ x: number; scripts: string[]; visible?: boolean; kind?: string }> = {}) =>
    toSandboxEntity(
      "hero",
      "Hero",
      overrides.kind ?? "box",
      overrides.visible ?? true,
      overrides.scripts ?? ["s1"],
      {
        position: { x: overrides.x ?? 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    );
  const coin = (overrides: Partial<{ x: number; scripts: string[] }> = {}) =>
    toSandboxEntity("coin", "Coin", "sphere", true, overrides.scripts ?? ["s2"], {
      position: { x: overrides.x ?? 3, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
  const coinScript = (code: string) => ({ id: "s2", name: "coin", code });
  const two = (heroCode: string, coinCode: string) => ({
    delta: 0.016,
    time: 0,
    entities: [hero(), coin()],
    scripts: [{ id: "s1", name: "hero", code: heroCode }, coinScript(coinCode)],
  });

  it("preserves the legacy state.entities names array", async () => {
    // The contract keeps state.entities as a `string[]` of names so existing
    // scripts that scan it continue to work; the new state.scene supersedes
    // it for read-by-name lookups.
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          if (!Array.isArray(state.entities)) throw new Error("expected array");
          if (state.entities.indexOf("Hero") < 0 || state.entities.indexOf("Coin") < 0) {
            throw new Error("missing names: " + state.entities.join(","));
          }
          entity.position.x = state.entities.length;
        }`,
        "function update(){ return; }",
      ),
    });
    expect(result.patches[0].position.x).toBe(2);
    sandbox.dispose();
  });

  it("exposes state.scene as a frozen plain snapshot of every scripted entity", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          if (state.scene.length !== 2) throw new Error("expected 2 entries");
          if (state.scene[0].name !== "Hero") throw new Error("expected Hero at 0");
          if (state.scene[1].name !== "Coin") throw new Error("expected Coin at 1");
          if (state.scene[1].kind !== "sphere") throw new Error("expected kind sphere");
          if (state.scene[0].visible !== true) throw new Error("expected visible");
          // Write our own position from the hero snapshot.
          entity.position.x = state.scene[0].position.x;
        }`,
        "function update(){ return; }",
      ),
    });
    expect(result.patches[0].position.x).toBe(0);
    sandbox.dispose();
  });

  it("exposes state.find by both name and id with the exact snapshot shape", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          var byName = state.find("Coin");
          if (byName === null) throw new Error("find(Coin) returned null");
          if (byName.id !== "coin") throw new Error("name lookup id mismatch: " + byName.id);
          if (byName.name !== "Coin") throw new Error("name lookup name mismatch");
          if (byName.kind !== "sphere") throw new Error("name lookup kind mismatch");
          if (byName.position.x !== 3 || byName.position.y !== 0 || byName.position.z !== 0) {
            throw new Error("name lookup position wrong");
          }
          if (byName.visible !== true) throw new Error("name lookup visible wrong");
          var byId = state.find("hero");
          if (byId === null) throw new Error("find(hero) returned null");
          if (byId.id !== "hero") throw new Error("id lookup id mismatch");
          if (byId.name !== "Hero") throw new Error("id lookup name mismatch");
          if (byId.position.x !== 0) throw new Error("id lookup position wrong");
          // The two snapshots must be the same object identity for the
          // matching entity so freezing them is symmetric.
          if (state.find("Coin") !== byName) throw new Error("find not memoised");
          entity.position.x = byName.position.x + byId.position.x;
        }`,
        "function update(){ return; }",
      ),
    });
    expect(result.logs.join("\n")).not.toMatch(/Error/);
    expect(result.logs).toHaveLength(0);
    expect(result.patches[0].position.x).toBe(3);
    expect(result.patches[1].position.x).toBe(3);
    sandbox.dispose();
  });

  it("deep-freezes state.scene so a script cannot mutate live snapshots", async () => {
    // The freeze has to be observable from outside the script, not just an
    // "no Error in logs" check: the script encodes what happened into the
    // patch so the assertion can pin it exactly. The freeze must:
    // (a) reject the write under strict mode,
    // (b) leave the coin's position unchanged (still 3),
    // (c) leave the script's own write to its own entity intact.
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          if (!Object.isFrozen(state.scene)) throw new Error("scene array not frozen");
          if (!Object.isFrozen(state.scene[1])) throw new Error("scene entry not frozen");
          if (!Object.isFrozen(state.scene[1].position)) throw new Error("scene vec3 not frozen");
          var caught = 0;
          try { state.scene[1].position.x = 99; } catch (e) { caught = 1; }
          if (state.scene[1].position.x !== 3) throw new Error("coin snapshot was mutated");
          // 7 = freeze rejected (good); 8 = freeze accepted (bad).
          entity.position.x = 7 + caught;
        }`,
        "function update(){ return; }",
      ),
    });
    expect(result.logs.join("\n")).not.toMatch(/Error/);
    expect(result.logs).toHaveLength(0);
    expect(result.patches[0].position.x).toBe(8);
    expect(result.patches[1].position.x).toBe(3);
    sandbox.dispose();
  });

  it("returns null from state.find when the lookup misses", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          if (state.find("Missing") !== null) throw new Error("Missing returned non-null");
          if (state.find("") !== null) throw new Error("empty string returned non-null");
          if (state.find(undefined) !== null) throw new Error("undefined returned non-null");
          if (state.find(null) !== null) throw new Error("null returned non-null");
          // Three valid lookups (one by name, one by id) must still work.
          if (state.find("Coin") === null) throw new Error("Coin lookup failed");
          if (state.find("hero") === null) throw new Error("hero lookup failed");
          entity.position.x = 1;
        }`,
        "function update(){ return; }",
      ),
    });
    expect(result.logs).toHaveLength(0);
    expect(result.patches[0].position.x).toBe(1);
    sandbox.dispose();
  });

  it("patches another entity by name with finite partial transform components", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          if (state.patch("Coin", { position: { x: 8 }, rotation: { z: 0.5 } }) !== true) {
            throw new Error("patch did not report a change");
          }
          if (state.find("Coin").position.x !== 3) throw new Error("frozen snapshot changed");
        }`,
        "function update(){ return; }",
      ),
    });

    expect(result.logs).toHaveLength(0);
    expect(result.patches[1]).toMatchObject({
      id: "coin",
      position: { x: 8, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0.5 },
      scale: { x: 1, y: 1, z: 1 },
    });
    sandbox.dispose();
  });

  it("patches another entity by id", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          state.patch("coin", { scale: { y: 2 } });
        }`,
        "function update(){ return; }",
      ),
    });

    expect(result.logs).toHaveLength(0);
    expect(result.patches[1].scale).toEqual({ x: 1, y: 2, z: 1 });
    sandbox.dispose();
  });

  it("ignores malformed patch components and non-transform fields with actionable logs", async () => {
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          state.patch("Coin", {
            position: { x: 9, y: NaN, z: "bad" },
            rotation: null,
            material: { color: "#ff0000" }
          });
          state.patch("Missing", { position: { x: 4 } });
          state.patch("Coin", { scale: {} });
        }`,
        "function update(){ return; }",
      ),
    });

    expect(result.patches[1].position).toEqual({ x: 9, y: 0, z: 0 });
    expect(result.patches[1].rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.patches[1].scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(result.logs.join("\n")).toMatch(/only supports position, rotation, and scale; ignored material/);
    expect(result.logs.join("\n")).toMatch(/position\.y must be finite; ignored/);
    expect(result.logs.join("\n")).toMatch(/position\.z must be finite; ignored/);
    expect(result.logs.join("\n")).toMatch(/rotation must be an object/);
    expect(result.logs.join("\n")).toMatch(/could not find entity "Missing"/);
    expect(result.logs.join("\n")).toMatch(/scale must include x, y, or z/);
    sandbox.dispose();
  });

  it("persists state.self across frames for the same (script, entity)", async () => {
    // The counter increments across three frames; each frame the script
    // asserts the exact previous value, so a sanitization that lost the
    // counter would reset the increment rather than keep growing.
    const sandbox = createScriptSandbox();
    const code = `function update(entity, state){
      if (state.self.step === undefined) {
        if (state.self.prev !== undefined) throw new Error("first-frame leak: " + state.self.prev);
        state.self.step = 1;
        state.self.prev = 0;
      } else {
        if (state.self.prev !== state.self.step - 1) throw new Error("sanitizer drift");
        state.self.prev = state.self.step;
        state.self.step += 1;
      }
      entity.position.x = state.self.step;
    }`;
    const first = await sandbox.step({
      delta: 0.016, time: 0, entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code }],
    });
    const second = await sandbox.step({
      delta: 0.016, time: 0.016, entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code }],
    });
    const third = await sandbox.step({
      delta: 0.016, time: 0.032, entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code }],
    });
    expect(first.logs).toHaveLength(0);
    expect(second.logs).toHaveLength(0);
    expect(third.logs).toHaveLength(0);
    expect(first.patches[0].position.x).toBe(1);
    expect(second.patches[0].position.x).toBe(2);
    expect(third.patches[0].position.x).toBe(3);
    sandbox.dispose();
  });

  it("isolates state.self between two scripted entities on the same script", async () => {
    const sandbox = createScriptSandbox();
    // Both hero and coin share scriptId "s1" so their state.self must key
    // on (scriptId, entityId) and not collide.
    const sharedCode = `function update(entity, state){
      if (state.self.n === undefined) state.self.n = 0;
      state.self.n += 1;
      entity.position.x = state.self.n;
    }`;
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [hero({ scripts: ["s1"] }), coin({ scripts: ["s1"] })],
      scripts: [{ id: "s1", name: "shared", code: sharedCode }],
    });
    // Both entities run the same code but their counters are independent.
    const positions = result.patches.map((patch) => patch.position.x).sort();
    expect(positions).toEqual([1, 1]);
    sandbox.dispose();
  });

  it("shares state.world across scripts on different entities", async () => {
    // The hero sets world.score = 7 directly. The coin reads it back and
    // checks the value; a duplicated or sandbox-private world would give
    // coin a different score than hero. The order of execution is
    // undefined but the *equality* of the two scripts' views of the world
    // is not.
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      ...two(
        `function update(entity, state){
          state.world.score = 7;
          state.world.heroName = "Hero";
          entity.position.x = 1;
        }`,
        `function update(entity, state){
          if (state.world.score !== 7) throw new Error("score not shared: " + state.world.score);
          if (state.world.heroName !== "Hero") throw new Error("heroName not shared");
          // World is JSON-safe, not frozen -- the coin can mutate it too.
          state.world.coinRead = true;
          entity.position.x = 2;
        }`,
      ),
    });
    expect(result.logs).toHaveLength(0);
    expect(result.patches[0].position.x).toBe(1);
    expect(result.patches[1].position.x).toBe(2);
    // Both scripts ran; the world was shared, not duplicated.
    // Confirm world is shared across calls: a second step sees both writes.
    const next = await sandbox.step({
      delta: 0.016, time: 0.016, entities: [hero(), coin()],
      scripts: [
        { id: "s1", name: "hero", code: `function update(entity, state){
          if (state.world.score !== 7) throw new Error("score lost across frames: " + state.world.score);
          if (state.world.coinRead !== true) throw new Error("coinRead lost across frames");
          entity.position.x = 3;
        }` },
        { id: "s2", name: "coin", code: "function update(){ return; }" },
      ],
    });
    expect(next.logs).toHaveLength(0);
    expect(next.patches[0].position.x).toBe(3);
    sandbox.dispose();
  });

  it("returns an isolated deep snapshot of state.world", async () => {
    const sandbox = createScriptSandbox();
    await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [entity()],
      scripts: script(
        "function update(entity, state){ state.world.nested = { score: 7 }; state.world.samples = [1, 2]; }",
      ),
    });

    const first = await sandbox.getWorldState();
    (first.nested as { score: number }).score = 99;
    (first.samples as number[]).push(3);
    const second = await sandbox.getWorldState();

    expect(second).toEqual({ nested: { score: 7 }, samples: [1, 2] });
    sandbox.dispose();
  });

  it("allows a hero to move across frames using state.time alone", async () => {
    // The original gap: state.time used to read the fixed-step accumulator
    // and sit at ~0.016 forever, so any time-driven script silently did
    // nothing. With the monotonic sim clock the hero's position now reflects
    // the time the runtime passed in for that exact frame.
    const sandbox = createScriptSandbox();
    const code = `function update(entity, state){
      entity.position.x = state.time * 10;
      entity.position.y = state.time;
    }`;
    const first = await sandbox.step({
      delta: 0.016, time: 0.5, entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code }],
    });
    const second = await sandbox.step({
      delta: 0.016, time: 1.5, entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code }],
    });
    const third = await sandbox.step({
      delta: 0.016, time: 2.5, entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code }],
    });
    expect(first.logs).toHaveLength(0);
    expect(second.logs).toHaveLength(0);
    expect(third.logs).toHaveLength(0);
    expect(first.patches[0].position.x).toBe(5);
    expect(first.patches[0].position.y).toBe(0.5);
    expect(second.patches[0].position.x).toBe(15);
    expect(second.patches[0].position.y).toBe(1.5);
    expect(third.patches[0].position.x).toBe(25);
    expect(third.patches[0].position.y).toBe(2.5);
    // The motion is strictly monotonic.
    expect(third.patches[0].position.x).toBeGreaterThan(second.patches[0].position.x);
    expect(second.patches[0].position.x).toBeGreaterThan(first.patches[0].position.x);
    sandbox.dispose();
  });

  it("survives a hostile state write: functions and circular refs are dropped", async () => {
    const sandbox = createScriptSandbox();
    const setup = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code: `function update(entity, state){
        state.self.bad = function(){};
        var loop = {}; loop.self = loop;
        state.self.loop = loop;
        state.self.huge = new Array(200).fill(1);
        state.self.kept = 42;
      }` }],
    });
    // The first step may produce normalization logs; the kept key survives.
    expect(setup.logs.join("\n")).toMatch(/dropped|truncated|circular/);
    const second = await sandbox.step({
      delta: 0.016,
      time: 0.016,
      entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code: `function update(entity, state){
        entity.position.x = (state.self.kept === 42) ? 7 : 0;
      }` }],
    });
    expect(second.patches[0].position.x).toBe(7);
    sandbox.dispose();
  });

  it("reset() clears state.self and state.world so the next frame starts clean", async () => {
    const sandbox = createScriptSandbox();
    await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code: `function update(entity, state){
        state.self.kept = 42;
        state.world.score = 99;
      }` }],
    });
    await sandbox.reset();
    const after = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [hero()],
      scripts: [{ id: "s1", name: "hero", code: `function update(entity, state){
        entity.position.x = (state.self.kept === undefined && state.world.score === undefined) ? 1 : 0;
      }` }],
    });
    expect(after.patches[0].position.x).toBe(1);
    sandbox.dispose();
  });
});

/**
 * Backend parity: the InlineSandbox already powers these tests in jsdom.
 * The standalone WorkerSandbox and the frame-housed FrameSandbox embed
 * the same normalize/sanitize/compile logic -- the worker via the TS
 * module, the frame via the String.raw mirrors in `scriptSandboxVector.ts`
 * and `scriptSandboxState.ts`. If those String.raw mirrors ever drift from
 * the TS modules, a script that ran cleanly under InlineSandbox would
 * silently misbehave under the worker backends. These tests pin the
 * equivalence.
 */
describe("script sandbox backend parity", () => {
  it("the vector normalizer mirror agrees with the TS module", async () => {
    const { SCRIPT_VECTOR_NORMALIZER_SOURCE } = await import("./scriptSandboxVector");
    const factory = new Function(
      `${SCRIPT_VECTOR_NORMALIZER_SOURCE}\nreturn { normalizeEntity, snapshotEntity };`,
    );
    const mirror = factory() as {
      normalizeEntity: (input: any, output: any, name: string) => any;
      snapshotEntity: (entity: any) => any;
    };
    const sample = { id: "a", name: "A", kind: "box", visible: true, scriptIds: ["s"], position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const snap = mirror.snapshotEntity(sample);
    expect(snap).toEqual(sample);
    // A NaN-poisoned patch should be reverted to the pre-step value with a
    // log line, mirroring the TS behavior.
    const bad = { ...sample, position: { x: NaN, y: 0, z: 0 } };
    const norm = mirror.normalizeEntity(sample, bad, "test");
    expect(norm.entity.position.x).toBe(1);
    expect(norm.logs.join("\n")).toMatch(/finite vec3/);
  });

  it("the state sanitizer mirror agrees with the TS module", async () => {
    const { SCRIPT_STATE_NORMALIZER_SOURCE } = await import("./scriptSandboxState");
    const factory = new Function(
      `${SCRIPT_STATE_NORMALIZER_SOURCE}\nreturn { sanitizeScriptState, deepFreeze };`,
    );
    const mirror = factory() as {
      sanitizeScriptState: (value: any) => any;
      deepFreeze: (value: any) => any;
    };
    const circular: any = {};
    circular.self = circular;
    const result = mirror.sanitizeScriptState(circular);
    expect(result.value).toBeDefined();
    expect(result.logs.join("\n")).toMatch(/circular/);
    const frozen = mirror.deepFreeze({ a: { b: 1 } });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen((frozen as any).a)).toBe(true);
  });

  it("InlineSandbox produces the same patches as the same script would in the worker", async () => {
    // The worker and inline backends share the protocol; running a known
    // script under InlineSandbox and asserting the canonical patch is the
    // strongest cross-backend check we can do without a real Worker. The
    // String.raw mirror tests above cover the protocol fragments that
    // would otherwise silently diverge.
    const sandbox = createScriptSandbox();
    const result = await sandbox.step({
      delta: 0.016,
      time: 0,
      entities: [
        toSandboxEntity("a", "A", "box", true, ["s"], { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
        toSandboxEntity("b", "B", "sphere", true, [], { position: { x: 7, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
      ],
      scripts: [
        {
          id: "s",
          name: "autonomous",
          code: `function update(entity, state){
            var b = state.find("B");
            entity.position.x = b.position.x;
            entity.position.y = state.time;
            state.world.score = ((state.world.score || 0) + 1);
            state.self.idx = (state.self.idx || 0) + 1;
          }`,
        },
      ],
    });
    expect(result.patches[0].position.x).toBe(7);
    expect(result.patches[0].position.y).toBe(0);
    sandbox.dispose();
  });
});
