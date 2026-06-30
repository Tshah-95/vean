import { describe, expect, it } from "vitest";
import { computeSlug, sanitizeSlug } from "../src/state/worktree";

// The worktree-identity primitive has exactly two pieces of pure logic that must
// be locked down without spawning git: the slug precedence (env → linked-worktree
// basename → branch → "primary") and the sanitizer that makes any of those forms
// filesystem/agent-browser-safe. resolveWorktreeSlug only *gathers* git facts and
// hands them to computeSlug, so covering computeSlug + sanitizeSlug here covers the
// whole decision surface deterministically.

describe("sanitizeSlug", () => {
  it("lowercases, replaces unsafe runs with a single dash, and trims dashes", () => {
    expect(sanitizeSlug("claude/Busy Moore #4")).toBe("claude-busy-moore-4");
  });

  it("keeps the allowed [a-z0-9._-] characters untouched", () => {
    expect(sanitizeSlug("busy-moore-4604ba")).toBe("busy-moore-4604ba");
    expect(sanitizeSlug("v1.2.3_rc")).toBe("v1.2.3_rc");
  });

  it("collapses runs of separators and trims leading/trailing dashes", () => {
    expect(sanitizeSlug("  feature///My Cool Thing!!  ")).toBe("feature-my-cool-thing");
    expect(sanitizeSlug("---edge---")).toBe("edge");
  });

  it("returns the empty string when nothing safe remains", () => {
    expect(sanitizeSlug("###")).toBe("");
  });
});

describe("computeSlug precedence", () => {
  it("env override wins over everything (source:env)", () => {
    expect(
      computeSlug({
        envOverride: "My Override!",
        isPrimary: false,
        branch: "claude/some-branch",
        toplevelBasename: "busy-moore-4604ba",
      }),
    ).toEqual({ slug: "my-override", source: "env" });
  });

  it("falls past an env override that sanitizes to empty", () => {
    expect(
      computeSlug({
        envOverride: "###",
        isPrimary: false,
        branch: null,
        toplevelBasename: "busy-moore-4604ba",
      }),
    ).toEqual({ slug: "busy-moore-4604ba", source: "worktree" });
  });

  it("uses the linked-worktree basename when not primary (source:worktree)", () => {
    expect(
      computeSlug({
        isPrimary: false,
        branch: "claude/Busy Moore #4",
        toplevelBasename: "busy-moore-4604ba",
      }),
    ).toEqual({ slug: "busy-moore-4604ba", source: "worktree" });
  });

  it("falls back to the sanitized branch on the primary checkout (source:branch)", () => {
    expect(
      computeSlug({
        isPrimary: true,
        branch: "claude/Busy Moore #4",
        toplevelBasename: "vean",
      }),
    ).toEqual({ slug: "claude-busy-moore-4", source: "branch" });
  });

  it("ignores the toplevel basename on the primary checkout", () => {
    expect(computeSlug({ isPrimary: true, branch: "main", toplevelBasename: "vean" })).toEqual({
      slug: "main",
      source: "branch",
    });
  });

  it("falls back to 'primary' when there is no branch (detached / outside a repo)", () => {
    expect(computeSlug({ isPrimary: true, branch: null, toplevelBasename: "vean" })).toEqual({
      slug: "primary",
      source: "fallback",
    });
  });

  it("falls back to 'primary' when a linked worktree basename sanitizes to empty and no branch", () => {
    expect(computeSlug({ isPrimary: false, branch: null, toplevelBasename: "###" })).toEqual({
      slug: "primary",
      source: "fallback",
    });
  });
});
