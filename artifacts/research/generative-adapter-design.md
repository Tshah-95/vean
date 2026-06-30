# Generative producer — the pluggable, opt-in `generate.*` adapter (designed, NOT built)

Date: 2026-06-30
Stream: S4 (roadmap T7). Status: **design only.** This note sketches the *later* in-app
generation path. It is the half of T7 we deliberately did **not** implement now.

## What shipped vs what this note covers

The decided posture (vean-next-roadmap §2 / §7 #2) splits T7 into two halves:

- **Built now (this stream):** `import-with-provenance`. You bring a clip a model produced
  *elsewhere* and vean PINS its typed origin to the clip so it **survives export**. This is
  `src/actions/generate-import.ts` (`importWithProvenance` helper + `timeline.importWithProvenance`
  action), riding on the H2 IR `provenance` field. vean makes **zero** network calls; the core
  stays no-network/no-secrets (Hard boundary #3). The differentiator vs Palmier: their
  `.palmier`→NLE-XML export is lossy and drops all AI metadata; ours is a first-class IR field
  that round-trips as `vean:provenance.*` producer properties.
- **Designed-later (this note):** the `generate.*` adapter that *produces* such a clip from a
  prompt by calling a model — the thing that would let a user generate b-roll *inside* vean
  instead of pasting in a file from another tool.

The seam between them is exactly the IR provenance field. Generation produces a file + a
`Provenance`; import is already the thing that pins a `Provenance` to a clip. So the adapter,
when it lands, **terminates in the already-shipped import path** — it never needs a new IR shape
or a new op.

## The hard constraint this design exists to satisfy

`src/ir`, `src/ops`, `src/diagnostics`, `src/driver` are deterministic/file-based with **no
network calls and no secrets** (AGENTS.md Hard boundary #3; the repo is public, AGPL, CLA-gated).
Generation is inherently the opposite: a network call to a hosted model, an API key, a
non-deterministic result, latency measured in minutes. The design problem is therefore **not**
"how do we call a model" — it is "how do we offer generation **without** contaminating the
no-network core." Three mechanisms do that, all of which already have precedent in the codebase.

## Mechanism 1 — generation is a JOB, never an inline action

The generic `jobs` table (`src/state/jobs.ts` + `src/state/schema.ts`) is the existing substrate
for slow, out-of-process, retryable work: a `kind` string + two opaque JSON blobs
(`payload_json` / `result_json`) and a claim-lease protocol (`queued` → `running` with
`locked_by` / `locked_until`). H3 already established the **typed-contract-over-generic-table**
pattern with `transcribe` (`src/state/job-types.ts`): per-kind Zod schemas for input/output, a
literal kind tag, encode/decode helpers, and a `transcribeJob(input)` builder — *interface only,
no backend*. The generate adapter follows that pattern exactly:

```ts
// src/state/job-types.ts (SKETCH — not written)
export const GENERATE_JOB_KIND = "generate" as const;

export const generateJobInputSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1),          // a Veo/Kling/Runway/… model id
  references: z.array(z.string()).optional(),
  durationFrames: z.number().int().positive().optional(),
  // profile target so the produced clip matches the timeline (rational fps, dims)
  profile: z.object({ width: z.number().int(), height: z.number().int(), fps: fpsSchema }),
});

export const generateJobOutputSchema = z.object({
  // the produced media lands ON DISK (state is cache/coordination only — AGENTS.md
  // "do not store assets/deliverables in vean.db"); the job records where.
  path: z.string().min(1),
  // the provenance to PIN — exactly the H2 `Provenance` shape, source:"generative".
  provenance: provenanceSchema,
});
```

Why a job and not an inline action:

- **It keeps the call OUT of the core.** The job queue is product/state-layer (`src/state/`),
  which is *allowed* coordination state; the core never sees it. A render is already modeled this
  way — long work happens *after* the lease transaction, never inside it.
- **Cancellable + retry-safe.** The `ActionContext` carries an injected `AbortSignal` (H1 DI,
  `ctx.signal`) for cooperative cancellation — a generation that takes minutes must be killable.
- **Non-blocking.** The CLI/MCP enqueues and returns a job id; the produced clip is imported when
  the job completes (a `generate` worker, on completion, calls the **already-shipped**
  `importWithProvenance` with `result.path` + `result.provenance`). The loop closes on existing
  code.

## Mechanism 2 — the network call lives in a SEPARATE WORKER, like the renderer sidecars

vean already shells generation-adjacent work out of process: `melt`/`ffmpeg` are **subprocess
sidecars**, never linked (Hard boundaries #1/#2); the decided transcription backend is a local
`whisper.cpp` sidecar (§7 #1), bundled by the app, treated as a system dep by source/CLI. The
generate worker is the same shape, one notch further out:

- The **core/CLI never imports an HTTP client.** The worker that drains `generate` jobs is its own
  process (or an opt-in plugin module the app loads). It holds the API client + the key; it reads a
  `generate` job's payload, calls the hosted model, writes the produced file to disk, and writes
  back `{ path, provenance }`. If that worker is absent, `generate` jobs simply sit `queued` — the
  rest of vean is unaffected and fully functional.
- **Provider plug-ins, not a hardcoded vendor.** Because the worker is decoupled behind the typed
  job contract, the model provider is swappable (the §2 research surveyed Veo 3.1 / Kling 3.0 /
  Seedance / Runway, and noted Sora's discontinuation) without touching vean's types. A provider is
  a function `(GenerateJobInput) → Promise<{ path, provenance }>`; vean ships the contract, a
  provider ships the call.

## Mechanism 3 — EXPLICIT, per-invocation OPT-IN; off by default; secrets never in core

Generation is **open-world** (it reaches the network), so the action runtime's existing policy/
effect metadata gates it. This is not new machinery — it is the metadata other actions already
declare:

- **Effect metadata** (`src/actions/types.ts` `ActionEffect`): the generate action declares
  `openWorld: true`, `idempotency: "non-idempotent"`, `approval: "ask-strong"`,
  `job: { mode: "queued", cancellable: true, retrySafe: true }`. Policy is evaluated **before**
  execution (`evaluatePolicy` in `src/actions/policy.ts`, threaded onto `ctx.policy` by H1) and
  projected to CLI confirmations, MCP `openWorldHint`, and Tauri capabilities. An open-world action
  cannot run silently.
- **A default-OFF feature gate.** Generation requires explicit enablement — a setting in
  `src/state/settings.ts` (the `vean config` settings primitive) such as `generate.enabled=false`
  by default, plus a provider id. With it off, the `generate.*` action either is not registered or
  returns a typed `policy`/`disabled` envelope. No surprise network calls, ever.
- **Secrets live OUTSIDE vean.** The API key is read by the *worker* from its own environment/
  keychain — never stored in `.vean/vean.db` (Hard boundary #3: "no secrets"; the state contract
  forbids secrets) and never committed. The core/CLI never sees a credential.

## How the pieces compose (the would-be flow)

```
  user: "generate a 2s dusk-skyline b-roll, no text"
        │
        ▼  CLI/MCP action  generate.broll  (openWorld:true, approval:ask-strong, queued job)
        │   • policy gate (must be opt-in + approved)         ← Mechanism 3
        │   • enqueue a `generate` job (typed payload)        ← Mechanism 1
        ▼
  jobs table: { kind:"generate", payload_json:{prompt,model,references,profile} }   [queued]
        │
        ▼  generate WORKER (separate process / opt-in plugin; holds the API key)    ← Mechanism 2
        │   • claim-lease → call hosted model → write /…/broll/skyline-dusk.mov
        │   • write result_json { path, provenance:{source:"generative",model,prompt,references} }
        ▼
  on completion → importWithProvenance(state, { resource:path, provenance })        ← SHIPPED NOW
        │   • pins provenance to the clip; appends via the pure `append` op
        ▼
  .mlt on disk: <producer> … <property name="vean:provenance.model">…</property>
        └─ SURVIVES EXPORT — the regenerate-in-place loop is now possible from the document alone.
```

The only net-new code when this lands: (a) the `generate` job contract in `job-types.ts` (mirrors
`transcribe`), (b) one or more `generate.*` actions with open-world/ask-strong effect metadata,
(c) the out-of-process worker + a provider plug-in interface, (d) a default-off setting. **None of
it touches `src/ir`, `src/ops`, `src/diagnostics`, or `src/driver`.** The core never learns that
generation exists; it only ever sees a file and a `Provenance`, which is precisely what the
shipped import path already consumes.

## Regenerate-in-place — the payoff the provenance field unlocks

Because the prompt/model/references survive export *in the document*, a later `generate.regenerate`
action can read a clip's `provenance` straight off the `.mlt`, re-enqueue a `generate` job with the
same (or an edited) prompt, and overwrite the clip's media in place — the use case Palmier markets
but structurally cannot persist, because its metadata dies on export. We get it for free the moment
the adapter exists, because the loop terminates in the same import path and the same IR field. That
is the whole point of having shipped the import half first: the moat is the **typed, exportable
provenance**, not the generation call, and the moat is already in the IR.

## Explicitly out of scope here

- No HTTP client, provider SDK, or API key handling anywhere in this stream.
- No `generate` job kind written to `src/state/job-types.ts` (the sketch above is illustrative).
- No `generate.*` action registered. The only registered action from S4 is
  `timeline.importWithProvenance` (and even that is left as a flagged commented registration in
  `src/actions/registry.ts` for the lead to sequence against the other parallel streams).
- No determinism claim for generated video: per §2, generative video is non-deterministic by
  construction; that is *why* it is confined to organic b-roll and why precise content stays on the
  deterministic Remotion/`.mlt` side. The adapter records *where a clip came from*; it does not make
  generation reproducible.
