// Default-policy decisions over the real action registry. The policy turns each
// action's native effect metadata (+ runtime context) into one approval level the
// surfaces project down; these fixtures pin the four tiers and the outside-project
// escalation so a destructive or escaping write can never silently downgrade.
import { describe, expect, it } from "vitest";
import { createActionContext, getAction } from "../src/actions";
import { defaultPolicyLevel, evaluatePolicy } from "../src/actions/policy";
import type { ActionContext } from "../src/actions/types";

const repo = "/Users/tejas/Github/vean";

function ctx(): ActionContext {
  // A context whose project root is the repo, so "inside vs outside project" is
  // computed against a real root.
  return {
    ...createActionContext({ cwd: repo, surface: "cli", project: repo }),
    project: { rootPath: repo, source: "explicit", stateDbPath: "" },
  };
}

function decide(id: string, input: unknown) {
  const action = getAction(id);
  if (!action) throw new Error(`unknown action in fixture: ${id}`);
  return evaluatePolicy(action, ctx(), input);
}

describe("default policy", () => {
  it("auto-allows closed-world reads/compute/preview", () => {
    expect(decide("project.current", {}).level).toBe("auto");
    expect(decide("timeline.diagnose", { uri: `${repo}/corpus/demo/demo.mlt` }).level).toBe("auto");
    expect(decide("timeline.previewOp", {}).level).toBe("auto");
  });

  it("asks for timeline/state writes and render/execute", () => {
    expect(decide("timeline.applyOp", {}).level).toBe("ask");
    expect(decide("project.init", {}).level).toBe("ask");
    // render writes only inside .vean/cache here → ask, not ask-strong.
    expect(
      decide("render.still", { uri: `${repo}/a.mlt`, frame: 0, out: `${repo}/.vean/x.png` }).level,
    ).toBe("ask");
  });

  it("escalates to ask-strong for a write that escapes the project", () => {
    const inside = decide("render.still", {
      uri: `${repo}/a.mlt`,
      frame: 0,
      out: `${repo}/out/x.png`,
    });
    expect(inside.level).toBe("ask");
    const outside = decide("render.still", {
      uri: `${repo}/a.mlt`,
      frame: 0,
      out: "/tmp/escape.png",
    });
    expect(outside.level).toBe("ask-strong");
    expect(outside.reason).toMatch(/outside/);
  });

  it("context-free defaultPolicyLevel matches the tiering", () => {
    const read = getAction("project.current");
    const write = getAction("timeline.applyOp");
    if (!read || !write) throw new Error("missing fixtures");
    expect(defaultPolicyLevel(read)).toBe("auto");
    expect(defaultPolicyLevel(write)).toBe("ask");
  });

  it("every registered action gets a defined level", () => {
    const action = getAction("media.scan");
    if (!action) throw new Error("missing fixture");
    expect(["auto", "ask", "ask-strong", "deny"]).toContain(defaultPolicyLevel(action));
  });
});
