import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index";

describe("vean scaffold", () => {
  it("exposes a version", () => {
    expect(typeof VERSION).toBe("string");
  });
});
