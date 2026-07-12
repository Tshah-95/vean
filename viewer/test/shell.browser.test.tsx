import { useEffect, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { cleanup } from "vitest-browser-react";
import { page } from "vitest/browser";

const api = vi.hoisted(() => ({
  fetchTimeline: vi.fn(),
  fetchProjects: vi.fn(async () => ({ ok: true, projects: [] })),
  fetchDiagnostics: vi.fn(async () => ({
    ok: true,
    health: { errors: 0, warnings: 0 },
    diagnostics: [],
  })),
  fetchWhereAmI: vi.fn(async () => ({
    worktreePath: "/fixture",
    slug: "fixture",
    branch: "test",
    isPrimary: false,
    source: "test",
    stateDbPath: "/fixture/.vean/vean.db",
    driveSession: null,
    veanBinResolvesTo: null,
    veanBinMatchesCheckout: true,
  })),
  runAction: vi.fn(async (id: string) => {
    if (id === "media.list") return [];
    throw new Error(`unregistered fixture action: ${id}`);
  }),
  renderStill: vi.fn(async () => ({ ok: true, stillUrl: "/still.png", frame: 0 })),
  renderVideo: vi.fn(async () => ({ ok: true, videoUrl: "/video.mp4" })),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ...api,
}));

import { App } from "../src/App";
import { ClockProvider, useClockInstance } from "../src/ClockProvider";
import { SourceProvider } from "../src/SourceProvider";
import { Transport } from "../src/components/Transport";
import { Drawer } from "../src/components/shell/Drawer";
import type { DrawerView } from "../src/components/shell/layout";

function ConfiguredTransport() {
  const clock = useClockInstance();
  const [volume, setVolume] = useState(0.75);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    clock.configure([30, 1], 120);
    // The transport no longer owns a scrub slider (the timeline ruler is the seek
    // surface), so drive the clock directly and assert the timecode readout follows.
    clock.seekTo(42);
  }, [clock]);
  return (
    <Transport
      editPoints={[0, 60]}
      volume={volume}
      muted={muted}
      onVolumeChange={setVolume}
      onMutedChange={setMuted}
      sinkId=""
      onSinkChange={() => {}}
    />
  );
}

/** The drawer as AppShell mounts it: a stateful view selection over the icon tabs. */
function ConfiguredDrawer() {
  const [view, setView] = useState<DrawerView>("media");
  return (
    <Drawer
      view={view}
      onSelect={setView}
      width={264}
      checksCount={0}
      route="timeline:fixture"
      baseTitle="Fixture"
    />
  );
}

describe("viewer shell browser contracts", () => {
  test("component.app.loading-error", async () => {
    api.fetchTimeline.mockImplementation(() => new Promise(() => {}));
    await page.render(<App />);
    await expect.element(page.getByText("Loading timeline…")).toBeVisible();
    await cleanup();

    api.fetchTimeline.mockRejectedValue(new Error("typed-fixture: timeline unavailable"));
    await page.render(<App />);
    await expect.element(page.getByText("Failed to load timeline")).toBeVisible();
    await expect.element(page.getByText(/typed-fixture: timeline unavailable/)).toBeVisible();
  });

  test("component.transport.semantic-controls", async () => {
    await page.render(
      <ClockProvider>
        <ConfiguredTransport />
      </ClockProvider>,
    );
    await expect.element(page.getByRole("button", { name: "Play" })).toBeVisible();
    await expect
      .element(page.getByRole("status", { name: "Playhead timecode" }))
      .toHaveTextContent("00:00:01:12");
    // Volume + mute live behind the audio menu (the macOS Sound-menu pattern).
    await page.getByRole("button", { name: "Audio" }).click();
    await page.getByRole("button", { name: "Mute" }).click();
    await expect.element(page.getByRole("button", { name: "Unmute" })).toBeVisible();
    await expect
      .element(page.getByRole("slider", { name: "Volume" }))
      .toHaveAttribute("aria-valuenow", "0");
  });

  test("component.drawer.tabs-and-actions", async () => {
    await page.render(
      <ClockProvider>
        <SourceProvider>
          <ConfiguredDrawer />
        </SourceProvider>
      </ClockProvider>,
    );
    const media = page.getByRole("tab", { name: "Media" });
    const jobs = page.getByRole("tab", { name: "Jobs" });
    await expect.element(media).toHaveAttribute("aria-selected", "true");
    await jobs.click();
    await expect.element(jobs).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByRole("tabpanel", { name: "Jobs" })).toBeVisible();
    await expect(api.runAction("unknown.action")).rejects.toThrow(
      "unregistered fixture action: unknown.action",
    );
  });

  test("component.console-failure-policy", async () => {
    // setup-browser owns the actual fail-after-test trap. This browser-side check
    // ensures the installed console function is the trap, not the native console.
    expect(console.error.toString()).toContain("unexpected.push");
  });
});
