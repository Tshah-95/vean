#!/usr/bin/env bun
// A standalone Bun helper that boots the preview server detached against a
// fixture project (timeline:main → a corpus .mlt) and probes the READ endpoints,
// printing a single JSON result line. Run under `bun` (so `bun:sqlite` resolves);
// `tests/preview-serve.test.ts` spawns it via spawnSync and asserts on the JSON.
// This keeps the HTTP integration check out of the Node/Vitest process while
// still gating it in `bun run test` (the test spawns this).
//
// Usage: bun scripts/preview-serve-probe.ts
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createActionContext, executeAction } from "../src/actions";
import { encodeTranscribeOutput } from "../src/state/job-types";
import { encodeTranscribeInput } from "../src/state/job-types";
import { completeJob, enqueueJob } from "../src/state/jobs";

const REPO = resolve(import.meta.dir, "..");

// The audio clip id the multitrack fixture parses to (producer2 → tone.wav). Stable
// per the fixture; used to address /api/peaks + /api/transcript by clip.
const AUDIO_CLIP_ID = "{7c1a0e2a-0004-4abc-9d00-000000000032}";

async function main() {
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-preview-probe-"));
  const configHome = mkdtempSync(join(tmpdir(), "vean-preview-probe-config-"));
  const mlt = join(projectRoot, "main.mlt");
  copyFileSync(join(REPO, "corpus", "shotcut-multitrack.mlt"), mlt);
  // The fixture's audio clip references `tone.wav` (a relative resource) — copy the
  // real 4s WAV next to the .mlt so the peaks/audioStreams probe has a real source.
  const tonePath = join(projectRoot, "tone.wav");
  copyFileSync(join(REPO, "corpus", "tone.wav"), tonePath);

  const ctx = createActionContext({
    cwd: projectRoot,
    env: { ...process.env, VEAN_CONFIG_HOME: configHome },
    surface: "test",
  });
  await executeAction("project.init", { repo: projectRoot }, ctx);
  await executeAction("timeline.use", { repo: projectRoot, target: mlt }, ctx);

  // Seed a COMPLETED transcribe job for tone.wav so /api/transcript returns a real
  // transcript (the read-side wiring: a done job row IS the transcript store). The
  // job payload path must equal the clip's RESOLVED absolute resource, which the
  // server compares against.
  const transcribed = enqueueJob(projectRoot, {
    kind: "transcribe",
    payloadJson: encodeTranscribeInput({ path: tonePath }),
  });
  completeJob(
    projectRoot,
    transcribed.id,
    encodeTranscribeOutput({
      segments: [
        {
          startFrame: 0,
          endFrame: 2,
          text: "tone check",
          words: [
            { startFrame: 0, endFrame: 1, text: "tone" },
            { startFrame: 1, endFrame: 2, text: "check" },
          ],
        },
      ],
    }),
  );

  // dev:false — this probe exercises the READ API + the dist static host, not the
  // live viewer. preview.serve now DEFAULTS to dev (auto-starts a Vite child); the
  // vitest gate must not, so opt into the prod/dist path explicitly.
  const served = await executeAction(
    "preview.serve",
    { repo: projectRoot, port: 0, open: false, detached: true, dev: false },
    ctx,
  );
  if (!served.ok) throw new Error(`preview.serve failed: ${JSON.stringify(served)}`);
  const out = served.output as { url: string; _stop: () => void };

  const getJson = async (path: string) => {
    const res = await fetch(`${out.url}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /** Capture the cross-origin isolation headers a response carries. The served
   *  viewer can only reach `crossOriginIsolated === true` if the top-level document
   *  ships COOP `same-origin` + COEP `require-corp`, and every subresource ships a
   *  CORP header. We assert the headers on BOTH the HTML document (`/`) and an API
   *  response so the test gate matches what the browser actually enforces. */
  const coiHeaders = async (path: string) => {
    const res = await fetch(`${out.url}${path}`);
    // Drain the body so the connection is released before teardown.
    await res.arrayBuffer().catch(() => undefined);
    return {
      status: res.status,
      coop: res.headers.get("cross-origin-opener-policy"),
      coep: res.headers.get("cross-origin-embedder-policy"),
      corp: res.headers.get("cross-origin-resource-policy"),
    };
  };

  try {
    const health = await getJson("/api/health");
    const timeline = await getJson("/api/timeline");
    const timelines = await getJson("/api/timelines");
    const diagnostics = await getJson("/api/diagnostics");
    const bad = await fetch(`${out.url}/api/nope`);
    // The document (`/`) is what the browser checks for isolation; the API stream
    // is a representative subresource that must stay CORP-compatible under COEP.
    const isolationHtml = await coiHeaders("/");
    const isolationApi = await coiHeaders("/api/health");
    const bootstrap = await fetch(`${out.url}/`);
    await bootstrap.arrayBuffer();
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const unauthorizedMutation = await fetch(`${out.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: out.url },
      body: JSON.stringify({ id: "missing.action" }),
    });
    const authorizedMutation = await fetch(`${out.url}/api/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: out.url,
        cookie,
        "x-vean-nonce": crypto.randomUUID(),
      },
      body: JSON.stringify({ id: "missing.action" }),
    });

    // ── Phase-3b endpoints ────────────────────────────────────────────────
    // The parsed timeline's audio clip (tone.wav) should carry audioStreams/hasAudio
    // from the ffprobe probe; a color clip carries neither.
    const allClips: Array<Record<string, unknown>> = [
      ...(timeline.body?.timeline?.tracks?.video ?? []),
      ...(timeline.body?.timeline?.tracks?.audio ?? []),
    ].flatMap((t: { items?: Array<Record<string, unknown>> }) => t.items ?? []);
    const audioClip = allClips.find((c) => c.id === AUDIO_CLIP_ID);
    const colorClip = allClips.find((c) => typeof c.service === "string" && c.service === "color");

    // /api/peaks by clipId for the tone.wav clip (a real 4s WAV → a non-empty
    // waveform). Addressing by clipId resolves the relative resource correctly.
    const peaks = await getJson(`/api/peaks?clipId=${encodeURIComponent(AUDIO_CLIP_ID)}&bins=64`);
    // Path-allowlist rejection: an arbitrary path is 403 (mirrors /api/media).
    const peaksForbidden = await fetch(
      `${out.url}/api/peaks?path=${encodeURIComponent("/etc/hosts")}`,
    );

    // /api/transcript by clipId → the seeded transcript (real words).
    const transcript = await getJson(`/api/transcript?clipId=${encodeURIComponent(AUDIO_CLIP_ID)}`);
    // /api/transcript for a color clip (non-file producer) → the never-faked empty case.
    const transcriptEmpty = colorClip
      ? await getJson(`/api/transcript?clipId=${encodeURIComponent(String(colorClip.id))}`)
      : { status: 200, body: { ok: true, words: [], transcript: null } };

    const result = {
      ok: true,
      url: out.url,
      isLocal: out.url.startsWith("http://127.0.0.1:"),
      health: { status: health.status, ok: health.body?.ok, repo: health.body?.repo },
      timeline: {
        status: timeline.status,
        ok: timeline.body?.ok,
        fps: timeline.body?.fps,
        totalFrames: timeline.body?.totalFrames,
        videoTracks: timeline.body?.timeline?.tracks?.video?.length,
        audioTracks: timeline.body?.timeline?.tracks?.audio?.length,
        // audioStreams/hasAudio surfaced on the audio clip; omitted on a color clip.
        audioClipHasAudio: audioClip?.hasAudio,
        audioClipStreams: audioClip?.audioStreams,
        colorClipHasAudioKey: colorClip ? "hasAudio" in colorClip : null,
      },
      timelines: {
        status: timelines.status,
        ok: timelines.body?.ok,
        count: timelines.body?.timelines?.length,
      },
      diagnostics: {
        status: diagnostics.status,
        ok: diagnostics.body?.ok,
        clean: diagnostics.body?.health?.clean,
      },
      peaks: {
        status: peaks.status,
        ok: peaks.body?.ok,
        bins: peaks.body?.bins,
        pairCount: Array.isArray(peaks.body?.peaks) ? peaks.body.peaks.length : null,
        sampleRate: peaks.body?.sampleRate,
        forbiddenStatus: peaksForbidden.status,
      },
      transcript: {
        status: transcript.status,
        ok: transcript.body?.ok,
        wordCount: Array.isArray(transcript.body?.words) ? transcript.body.words.length : null,
        firstWord: transcript.body?.words?.[0]?.text,
        hasStableIds: transcript.body?.words?.every?.(
          (w: { id?: unknown }) => typeof w.id === "string" && w.id.length > 0,
        ),
        emptyWordCount: Array.isArray(transcriptEmpty.body?.words)
          ? transcriptEmpty.body.words.length
          : null,
        emptyTranscriptNull: transcriptEmpty.body?.transcript === null,
      },
      badEndpointStatus: bad.status,
      isolationHtml,
      isolationApi,
      mutationAuthority: {
        bootstrapCookieHttpOnly: bootstrap.headers.get("set-cookie")?.includes("HttpOnly") ?? false,
        unauthorizedStatus: unauthorizedMutation.status,
        authorizedStatus: authorizedMutation.status,
      },
    };
    // Release the forbidden-peaks response body before teardown.
    await peaksForbidden.arrayBuffer().catch(() => undefined);
    console.log(JSON.stringify(result));
  } finally {
    out._stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    process.exit(1);
  });
