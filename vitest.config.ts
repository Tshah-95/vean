import { configDefaults, defineConfig } from "vitest/config";

// Root vitest config. Its one job today is GATE HYGIENE for the worktree-native
// model (DESIGN-WORKTREE.md §4.7): Claude task-chip worktrees live under
// `.claude/worktrees/<name>/` (gitignored) and carry their OWN full copy of
// `tests/`. Vitest's default `**/*.test.ts` glob would otherwise collect every
// nested worktree's suite into the PRIMARY checkout's run — inflating the run by
// thousands of tests and failing the parent gate on a sibling branch's drift.
// Excluding the nested-worktree root keeps `bun run test` scoped to THIS tree.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**", "e2e/**", "viewer/test/**"],
  },
});
