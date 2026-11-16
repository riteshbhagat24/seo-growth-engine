import { describe, expect, it } from "vitest";
import { runTick } from "../src/runner";

describe("runTick", () => {
  it("stops when the queue is empty", async () => {
    let jobs = 3;
    const r = await runTick(async () => (jobs-- > 0), 10_000);
    expect(r).toEqual({ processed: 3, stoppedBecause: "idle" });
  });

  it("stops when the time budget is spent", async () => {
    let t = 0;
    const r = await runTick(async () => ((t += 100), true), 250, () => t);
    expect(r).toEqual({ processed: 3, stoppedBecause: "time_budget" });
  });
});
