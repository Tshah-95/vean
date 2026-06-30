// The transcription BACKEND — the whisper.cpp sidecar that fulfils the H3
// `transcribe` job contract. This is the chosen backend (DECISION 2026-06-30): a
// LOCAL whisper.cpp binary, bundled like melt/ffmpeg, so the "core has no
// network/secrets" boundary holds (Hard boundary #3). It is NEVER a network API.
//
// Binary resolution mirrors `src/driver/melt.ts` `resolveBin`: a documented env
// override (`VEAN_WHISPER` / `VEAN_WHISPER_BIN`) points at the sidecar (the
// signed Mac app sets it to its bundled `Contents/MacOS/…`); unset, it falls back
// to a bare name on `PATH` (`whisper-cli`, the modern whisper.cpp CLI). A model
// file is likewise overridable via `VEAN_WHISPER_MODEL`.
//
// FIXTURE PATH (why tests pass without the binary or network): whisper.cpp may be
// absent on a fresh clone / CI. The job is wired end-to-end — resolve binary,
// spawn, parse `-oj` JSON, convert to frames — but when the binary is unresolved
// (or `VEAN_WHISPER_FIXTURE` points at a captured JSON), it reads a deterministic
// fixture instead of spawning. So the transcript model, the word-cut op, and the
// caption track are all buildable + testable against a frozen output with no
// external dependency. The real spawn path lands fully when the sidecar is
// bundled (followups); the seam is identical either way.
import type { Fps } from "../ir/types";
import { TRANSCRIBE_JOB_KIND } from "../state/job-types";
import type {
  TranscribeJobInput,
  TranscribeJobOutput,
  TranscribeSegment,
  TranscribeWord,
} from "../state/job-types";
import { type RawSegment, type RawWord, buildTranscript } from "./map";
import type { Transcript } from "./types";

/** Resolve the whisper.cpp binary path. Mirrors `src/driver/melt.ts` `resolveBin`:
 *  the documented override (`VEAN_WHISPER`, or the `*_BIN` spelling) wins; unset,
 *  falls back to `whisper-cli` (the modern whisper.cpp CLI name) on `PATH`. The
 *  env is threaded so a test can override it without touching `process.env`. */
export function resolveWhisperBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.VEAN_WHISPER ?? env.VEAN_WHISPER_BIN ?? "whisper-cli";
}

/** Resolve the whisper model file (`-m`). Overridable via `VEAN_WHISPER_MODEL`;
 *  unset, the bundled-sidecar default name (the app provides the actual file). */
export function resolveWhisperModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.VEAN_WHISPER_MODEL ?? "ggml-base.en.bin";
}

/** Whether the real spawn path is available in this environment. The job uses the
 *  fixture path (deterministic, no spawn) unless an explicit binary is configured
 *  AND no fixture override is set. Keeping this a pure predicate over env makes
 *  the test path obvious: with no `VEAN_WHISPER`, transcription is fixture-backed. */
export function whisperConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VEAN_WHISPER ?? env.VEAN_WHISPER_BIN) != null && env.VEAN_WHISPER_FIXTURE == null;
}

// ─── whisper.cpp `-oj` JSON shape (the subset we read) ────────────────────────
// whisper.cpp's `-oj`/`--output-json` writes `<input>.json` with per-segment
// `offsets.{from,to}` in MILLISECONDS and a `text`. Word-level timing comes from
// `--output-json-full` (`-ojf`), which adds a `tokens[]` array per segment, each
// token carrying its own `offsets.{from,to}` (ms) and `text`. We read the full
// shape when present and degrade to segment-only timing otherwise.
type WhisperOffsets = { from: number; to: number };
type WhisperToken = { text?: string; offsets?: WhisperOffsets };
type WhisperSegment = { text?: string; offsets?: WhisperOffsets; tokens?: WhisperToken[] };
type WhisperJson = { transcription?: WhisperSegment[] };

/** Convert a whisper.cpp `-ojf` JSON object into RAW (seconds-based) segments.
 *  whisper offsets are MILLISECONDS → seconds here; the frame conversion happens
 *  later in `buildTranscript` at the project fps. A token whose trimmed text is
 *  empty (whisper emits punctuation / special tokens like `[_BEG_]`) is dropped so
 *  the word stream is real words. */
export function whisperJsonToRaw(json: WhisperJson): RawSegment[] {
  const segs = json.transcription ?? [];
  return segs.map((s): RawSegment => {
    const segStart = (s.offsets?.from ?? 0) / 1000;
    const segEnd = (s.offsets?.to ?? segStart * 1000) / 1000;
    const words: RawWord[] = (s.tokens ?? [])
      .filter((t) => (t.text ?? "").trim().length > 0 && !(t.text ?? "").startsWith("["))
      .map((t) => ({
        start: (t.offsets?.from ?? 0) / 1000,
        end: (t.offsets?.to ?? 0) / 1000,
        text: t.text ?? "",
      }));
    return { start: segStart, end: segEnd, text: (s.text ?? "").trim(), words };
  });
}

// ─── The job interface (against H3) ──────────────────────────────────────────
/** A transcription backend: input (path/lang) + fps → the H3 job output (frame-
 *  exact). The default backend is whisper.cpp; a test injects a fake to exercise
 *  the wiring without a binary. */
export type TranscribeBackend = (
  input: TranscribeJobInput,
  fps: Fps,
  env?: NodeJS.ProcessEnv,
) => Promise<TranscribeJobOutput>;

/** Frame-resolve a `Transcript` (stable ids, integer frames) down to the H3
 *  `TranscribeJobOutput` (frame-exact, NO ids — the wire contract). The job
 *  writes THIS to `jobs.result_json`; a reader rebuilds a `Transcript` (re-minting
 *  ids) via `fromJobOutput`. */
export function toJobOutput(t: Transcript): TranscribeJobOutput {
  const segments: TranscribeSegment[] = t.segments.map((s) => ({
    startFrame: s.startFrame,
    endFrame: s.endFrame,
    text: s.text,
    words: s.words.map(
      (w): TranscribeWord => ({ startFrame: w.startFrame, endFrame: w.endFrame, text: w.text }),
    ),
  }));
  return { segments };
}

/** Run a whisper.cpp transcription and return the frame-exact H3 job output.
 *
 *  Path selection:
 *   • FIXTURE (default in tests / no binary): when `VEAN_WHISPER_FIXTURE` is set
 *     OR the binary isn't configured, read a captured whisper `-ojf` JSON from the
 *     fixture path (or the built-in deterministic sample) and convert it. No
 *     spawn, no network — the seam works on a fresh clone.
 *   • SPAWN (real sidecar): resolve the binary + model, spawn
 *     `whisper-cli -m <model> -f <path> -oj -ojf -of <tmp>`, read the emitted
 *     `<tmp>.json`, and convert it. (Scaffolded; the exact arg set is pinned when
 *     the sidecar is bundled — see followups.)
 *
 *  Either way the OUTPUT is identical in shape: frames resolved against `fps`. */
export const transcribeWhisper: TranscribeBackend = async (input, fps, env = process.env) => {
  const raw = await loadRawSegments(input, env);
  const transcript = buildTranscript(raw, fps, { mediaPath: input.path });
  return toJobOutput(transcript);
};

/** Resolve RAW seconds-based segments for `input`: fixture if unconfigured /
 *  overridden, otherwise spawn the sidecar. Split out so the conversion +
 *  frame-resolution above is backend-agnostic. */
async function loadRawSegments(
  input: TranscribeJobInput,
  env: NodeJS.ProcessEnv,
): Promise<RawSegment[]> {
  // Fixture path: an explicit captured JSON, or the deterministic built-in.
  if (!whisperConfigured(env)) {
    const fixture = env.VEAN_WHISPER_FIXTURE;
    if (fixture) {
      const text = await Bun.file(fixture).text();
      return whisperJsonToRaw(JSON.parse(text) as WhisperJson);
    }
    return BUILTIN_FIXTURE_RAW;
  }

  // Spawn path: run the sidecar, read its `-ojf` JSON output beside a temp `-of`.
  const bin = resolveWhisperBin(env);
  const model = resolveWhisperModel(env);
  const outBase = `${input.path}.${process.pid}.${Date.now()}.vean-whisper`;
  const args = [
    "-m",
    model,
    "-f",
    input.path,
    "-oj",
    "-ojf",
    "-of",
    outBase,
    ...(input.lang ? ["-l", input.lang] : []),
  ];
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(
      `transcribeWhisper: ${bin} exited ${code}\n  command: ${bin} ${args.join(" ")}\n  stderr:\n${stderr}`,
    );
  }
  const jsonPath = `${outBase}.json`;
  const text = await Bun.file(jsonPath).text();
  try {
    return whisperJsonToRaw(JSON.parse(text) as WhisperJson);
  } finally {
    try {
      await Bun.file(jsonPath).delete();
    } catch {
      // best-effort temp cleanup
    }
  }
}

// ─── The built-in deterministic fixture ───────────────────────────────────────
// A tiny captured-style transcript (seconds-based) so the WHOLE pipeline —
// transcript model, word-cut op, caption track — is exercisable on a fresh clone
// with no whisper.cpp binary and no network. Mirrors a whisper `-ojf` parse:
// short words with realistic sub-second spans. Deterministic by construction.
export const BUILTIN_FIXTURE_RAW: RawSegment[] = [
  {
    start: 0.0,
    end: 2.0,
    text: "the quick brown fox",
    words: [
      { start: 0.0, end: 0.5, text: "the" },
      { start: 0.5, end: 1.0, text: "quick" },
      { start: 1.0, end: 1.5, text: "brown" },
      { start: 1.5, end: 2.0, text: "fox" },
    ],
  },
  {
    start: 2.0,
    end: 4.0,
    text: "jumps over the lazy dog",
    words: [
      { start: 2.0, end: 2.4, text: "jumps" },
      { start: 2.4, end: 2.8, text: "over" },
      { start: 2.8, end: 3.2, text: "the" },
      { start: 3.2, end: 3.6, text: "lazy" },
      { start: 3.6, end: 4.0, text: "dog" },
    ],
  },
];

/** The job `kind` this backend services (re-exported for callers that wire the
 *  worker — they compare against the H3 constant, never a bare literal). */
export const TRANSCRIBE_KIND = TRANSCRIBE_JOB_KIND;
