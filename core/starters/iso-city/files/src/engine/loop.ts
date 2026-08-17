/**
 * A fixed-timestep simulation driven by a variable-rate render.
 *
 * The simulation must not advance by however long the last frame happened to
 * take: a dropped frame would make the city jump, and the same input would
 * produce different results on different machines. Rendering still runs as
 * fast as the display allows.
 */

/** Simulation steps per second. */
const TICK_HZ = 20;
const STEP_MS = 1000 / TICK_HZ;

/**
 * Never simulate more than this many steps for one frame. Without the cap, a
 * backgrounded tab returning after a minute would try to run 1200 steps in one
 * frame and lock the page — the "spiral of death".
 */
const MAX_STEPS_PER_FRAME = 5;

export interface LoopHandle {
  stop(): void;
}

export function startLoop(tick: () => void, render: () => void): LoopHandle {
  let previous = performance.now();
  let accumulator = 0;
  let frame = 0;

  const step = (now: number) => {
    frame = requestAnimationFrame(step);
    accumulator += now - previous;
    previous = now;

    let steps = 0;
    while (accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      tick();
      accumulator -= STEP_MS;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

    render();
  };

  frame = requestAnimationFrame(step);
  return {
    stop() {
      cancelAnimationFrame(frame);
    },
  };
}
