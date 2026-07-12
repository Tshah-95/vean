import { useEffect, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { cleanup } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

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
import { Sidebar } from "../src/components/Sidebar";
import { Transport } from "../src/components/Transport";

function ConfiguredTransport() {
  const clock = useClockInstance();
  const [volume, setVolume] = useState(0.75);
  const [muted, setMuted] = useState(false);
  useEffect(() => clock.configure([30, 1], 120), [clock]);
  return (
    <Transport
      volume={volume}
      muted={muted}
      onVolumeChange={setVolume}
      onMutedChange={setMuted}
      sinkId=""
      onSinkChange={() => {}}
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
    const playhead = page.getByRole("slider", { name: "Playhead frame" });
    await userEvent.fill(playhead, "42");
    await expect
      .element(page.getByRole("status", { name: "Playhead timecode" }))
      .toHaveTextContent("00:00:01:12");
    await page.getByRole("button", { name: "Mute" }).click();
    await expect.element(page.getByRole("button", { name: "Unmute" })).toBeVisible();
    await expect.element(page.getByRole("slider", { name: "Volume" })).toHaveValue("0");
  });

  test("component.sidebar.tabs-and-actions", async () => {
    await page.render(
      <ClockProvider>
        <Sidebar route="timeline:fixture" baseTitle="Fixture" />
      </ClockProvider>,
    );
    const media = page.getByRole("tab", { name: "Media" });
    const render = page.getByRole("tab", { name: "Render" });
    await expect.element(media).toHaveAttribute("aria-selected", "true");
    await render.click();
    await expect.element(render).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByRole("tabpanel", { name: "Render" })).toBeVisible();
    await page.getByRole("button", { name: "Hide panels" }).click();
    await expect.element(page.getByRole("button", { name: "Show panels" })).toBeVisible();
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
