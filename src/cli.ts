#!/usr/bin/env bun
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  createActionContext,
  describeAction,
  executeAction,
  getAction,
  listActions,
} from "./actions";
import { buildConfigCommand } from "./cli/config";
import { type DoctorHost, type DoctorSurface, formatDoctorReport } from "./cli/doctor";
import { buildFpsCommand } from "./cli/fps";

const program = new Command();

function parseHost(value: string): DoctorHost {
  if (value === "all" || value === "claude-code" || value === "codex") return value;
  throw new InvalidArgumentError("expected one of: all, claude-code, codex");
}

function parseSurface(value: string): DoctorSurface {
  if (
    value === "all" ||
    value === "cli" ||
    value === "lsp" ||
    value === "mcp" ||
    value === "cli-lsp" ||
    value === "mcp-lsp"
  )
    return value;
  throw new InvalidArgumentError("expected one of: all, cli, lsp, mcp, cli-lsp, mcp-lsp");
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new InvalidArgumentError("expected an integer");
  return parsed;
}

function parseJson<T = unknown>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new InvalidArgumentError("expected valid JSON");
  }
}

function assertJson(value: string): string {
  parseJson(value);
  return value;
}

function context() {
  const opts = program.opts<{ cwd?: string; project?: string }>();
  return createActionContext({ cwd: opts.cwd, project: opts.project, surface: "cli" });
}

/** Write the whole buffer to fd 1, draining backpressure synchronously. When
 *  vean's stdout is a pipe (a test's spawnSync, a shell pipeline) the fd is
 *  often non-blocking, so a large write (the discover manifest is >64KB, past
 *  the OS pipe buffer) returns a SHORT count or throws EAGAIN once the buffer
 *  fills. Bun's `console.log` hits the same wall (it writes async and the
 *  process can exit before the reader drains, truncating at 64KB). We loop over
 *  partial writes AND retry on EAGAIN — the reader drains continuously, so each
 *  retry makes progress — until every byte is handed off. This guarantees a
 *  piped reader receives the complete JSON. */
function writeAllSync(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset, buf.length - offset);
    } catch (err) {
      // The pipe is momentarily full (non-blocking fd). Retry the same offset;
      // the consumer is draining, so the next write will accept more bytes.
      if ((err as NodeJS.ErrnoException)?.code === "EAGAIN") continue;
      throw err;
    }
  }
}

function printJson(value: unknown): void {
  writeAllSync(`${JSON.stringify(value, null, 2)}\n`);
}

async function runAction(actionId: string, input: unknown) {
  const envelope = await executeAction(actionId, input, context());
  if (!envelope.ok) {
    throw new Error(`${envelope.kind}: ${envelope.detail}`);
  }
  return envelope.output;
}

function isSemanticFailure(output: unknown): output is { ok: false; kind: string; detail: string } {
  return (
    typeof output === "object" &&
    output !== null &&
    "ok" in output &&
    (output as { ok?: unknown }).ok === false
  );
}

async function printActionOutput(
  actionId: string,
  input: unknown,
  json?: boolean,
): Promise<unknown> {
  const envelope = await executeAction(actionId, input, context());
  if (!envelope.ok) {
    if (json) {
      printJson(envelope);
      process.exit(1);
    }
    throw new Error(`${envelope.kind}: ${envelope.detail}`);
  }
  const output = envelope.output;
  if (json) printJson(output);
  if (isSemanticFailure(output)) process.exit(1);
  return output;
}

program
  .name("vean")
  .description("Agent-native video editing core")
  .version("0.0.0")
  .option("--cwd <path>", "working directory for project resolution")
  .option("--project <id-or-path>", "project id or path for project-aware commands");

program
  .command("doctor")
  .description(
    "Verify local dependencies, agent skills, Claude Code plugin config, and stdio servers",
  )
  .option("--repo <path>", "repo path to inspect")
  .option("--host <host>", "host integration to check: all, claude-code, codex", parseHost, "all")
  .option(
    "--surface <surface>",
    "tool surface to check: all, cli, lsp, mcp, cli-lsp, mcp-lsp",
    parseSurface,
    "lsp",
  )
  .option("--json", "emit JSON")
  .option("--strict", "exit nonzero on warnings as well as failures")
  .option("--no-probe", "skip stdio LSP/MCP startup probes")
  .action(
    async (opts: {
      repo?: string;
      host: DoctorHost;
      json?: boolean;
      strict?: boolean;
      probe?: boolean;
      surface?: DoctorSurface;
    }) => {
      const report = await runAction("setup.doctor", {
        ...opts,
        repo: opts.repo ?? process.cwd(),
      });
      if (opts.json) printJson(report);
      else console.log(formatDoctorReport(report as never));
      const checks = (report as { checks: Array<{ status: string }> }).checks;
      const ok = (report as { ok: boolean }).ok;
      const hasWarnings = checks.some((c) => c.status === "warn");
      process.exit(ok && !(opts.strict && hasWarnings) ? 0 : 1);
    },
  );

const actionsCommand = program.command("action").description("Inspect and run vean actions");

actionsCommand
  .command("list")
  .description("List registered actions")
  .option("--json", "emit JSON")
  .action((opts: { json?: boolean }) => {
    const descriptors = listActions().map(describeAction);
    if (opts.json) printJson(descriptors);
    else {
      for (const action of descriptors) {
        const cli =
          action.surfaces.cli && "command" in action.surfaces.cli
            ? `\t${action.surfaces.cli.command}`
            : "";
        console.log(`${action.id}${cli}`);
      }
    }
  });

actionsCommand
  .command("describe <id>")
  .description("Describe a registered action")
  .option("--json", "emit JSON")
  .action((id: string, opts: { json?: boolean }) => {
    const action = getAction(id);
    if (!action) throw new Error(`unknown action: ${id}`);
    const descriptor = describeAction(action);
    if (opts.json) printJson(descriptor);
    else {
      console.log(`${descriptor.id}: ${descriptor.title}`);
      console.log(descriptor.description);
    }
  });

actionsCommand
  .command("run <id>")
  .description("Run an action by id with JSON input")
  .option("--input-json <json>", "action input JSON", assertJson, "{}")
  .option("--json", "emit JSON envelope", true)
  .action(async (id: string, opts: { inputJson: string; json?: boolean }) => {
    const envelope = await executeAction(id, parseJson(opts.inputJson), context());
    if (opts.json) printJson(envelope);
    else if (envelope.ok) printJson(envelope.output);
    else console.error(`${envelope.kind}: ${envelope.detail}`);
    process.exit(envelope.ok ? 0 : 1);
  });

actionsCommand
  .command("docs")
  .description("Emit action documentation data")
  .option("--format <format>", "json or markdown", "json")
  .action((opts: { format: string }) => {
    const descriptors = listActions().map(describeAction);
    if (opts.format === "json") {
      printJson(descriptors);
      return;
    }
    if (opts.format !== "markdown") {
      throw new InvalidArgumentError("expected one of: json, markdown");
    }
    for (const action of descriptors) {
      console.log(`### ${action.id}`);
      console.log("");
      console.log(action.description);
      console.log("");
      console.log(`Scopes: ${action.scopes.join(", ") || "none"}`);
      console.log("");
    }
  });

program
  .command("discover [query]")
  .description("Discover vean commands, actions, timeline ops, and routes")
  .option("--kind <kind>", "all, command, action, op, or route", "all")
  .option("--limit <n>", "maximum results", "10")
  .option("--json", "emit JSON")
  .action(
    async (query: string | undefined, opts: { kind: string; limit: string; json?: boolean }) => {
      const actionId = query ? "discover.search" : "discover.manifest";
      const input = query ? { query, kind: opts.kind, limit: opts.limit } : {};
      const output = await printActionOutput(actionId, input, opts.json);
      if (!opts.json) printJson(output);
    },
  );

const timeline = program.command("timeline").description("Inspect and edit .mlt timelines");

const timelineOps = timeline.command("ops").description("Discover public timeline edit operations");

timelineOps
  .command("list")
  .description("List public timeline operations")
  .option("--category <category>", "filter by op category")
  .option("--json", "emit JSON")
  .action(async (opts: { category?: string; json?: boolean }) => {
    const output = await printActionOutput("timeline.ops.list", opts, opts.json);
    if (!opts.json) printJson(output);
  });

timelineOps
  .command("describe <op>")
  .description("Describe a public timeline operation")
  .option("--json", "emit JSON")
  .action(async (op: string, opts: { json?: boolean }) => {
    const output = await printActionOutput("timeline.ops.describe", { op }, opts.json);
    if (!opts.json) printJson(output);
  });

timelineOps
  .command("examples <op>")
  .description("Show valid example args for a timeline operation")
  .option("--json", "emit JSON")
  .action(async (op: string, opts: { json?: boolean }) => {
    const output = await printActionOutput("timeline.ops.examples", { op }, opts.json);
    if (!opts.json) printJson(output);
  });

timeline
  .command("list")
  .description("List cataloged and routed .mlt timelines")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const output = await printActionOutput("timeline.list", opts, opts.json);
    if (!opts.json) printJson(output);
  });

timeline
  .command("use <target>")
  .description("Set timeline:main to a .mlt path, file:// URI, or route alias")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (target: string, opts: { repo?: string; json?: boolean }) => {
    const output = await printActionOutput("timeline.use", { ...opts, target }, opts.json);
    if (!opts.json) printJson(output);
  });

timeline
  .command("current")
  .description("Resolve the active timeline:main route")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const output = await printActionOutput("timeline.current", opts, opts.json);
    if (!opts.json) printJson(output);
  });

timeline
  .command("new <out>")
  .description("Create a blank .mlt timeline from a profile preset")
  .option(
    "--profile <name>",
    "vertical, square, landscape, landscape-2997, landscape-23976",
    "vertical",
  )
  .option("--title <title>", "timeline title", "vean timeline")
  .option("--video-tracks <n>", "number of empty video tracks", parseInteger, 1)
  .option("--audio-tracks <n>", "number of empty audio tracks", parseInteger, 1)
  .option("--no-use", "do not set timeline:main to the new file")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(
    async (
      out: string,
      opts: {
        profile: string;
        title: string;
        videoTracks: number;
        audioTracks: number;
        use?: boolean;
        repo?: string;
        json?: boolean;
      },
    ) => {
      const output = await printActionOutput(
        "timeline.new",
        {
          out,
          profile: opts.profile,
          title: opts.title,
          videoTracks: opts.videoTracks,
          audioTracks: opts.audioTracks,
          use: opts.use !== false,
          repo: opts.repo,
        },
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

timeline
  .command("add-graphic")
  .description("Composite a pre-rendered alpha graphic clip over the footage on an upper track")
  .requiredOption("--clip-path <mov>", "absolute path to the rendered alpha .mov")
  .requiredOption("--position <frame>", "timeline frame the overlay starts at", parseInteger)
  .requiredOption("--duration <frames>", "overlay duration in frames", parseInteger)
  .option("--new-track", "force a fresh top GFX video track")
  .option("--blend-service <service>", "cross-track blend service", "qtblend")
  .option("--label <label>", "clip label")
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .option("--json", "emit JSON")
  .action(
    async (opts: {
      clipPath: string;
      position: number;
      duration: number;
      newTrack?: boolean;
      blendService: string;
      label?: string;
      timeline?: string;
      json?: boolean;
    }) => {
      const output = await printActionOutput(
        "timeline.addGraphic",
        {
          clipPath: opts.clipPath,
          position: opts.position,
          durationFrames: opts.duration,
          newTrack: opts.newTrack ?? false,
          blendService: opts.blendService,
          label: opts.label,
          timeline: opts.timeline,
        },
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

timeline
  .command("add-audio")
  .description(
    "Append an audio clip (music/voiceover) to an audio track, with optional gain and fades",
  )
  .requiredOption("--resource <path>", "absolute path to the audio file")
  .requiredOption("--duration <frames>", "clip duration in frames", parseInteger)
  .option("--in <frame>", "source in-point", parseInteger, 0)
  .option("--gain-db <db>", "gain in decibels", (v) => Number.parseFloat(v))
  .option("--fade-in <frames>", "fade-in length in frames", parseInteger)
  .option("--fade-out <frames>", "fade-out length in frames", parseInteger)
  .option("--track-id <id>", "target audio track id")
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .option("--json", "emit JSON")
  .action(
    async (opts: {
      resource: string;
      duration: number;
      in: number;
      gainDb?: number;
      fadeIn?: number;
      fadeOut?: number;
      trackId?: string;
      timeline?: string;
      json?: boolean;
    }) => {
      const output = await printActionOutput(
        "timeline.addAudio",
        {
          resource: opts.resource,
          durationFrames: opts.duration,
          inFrame: opts.in,
          gainDb: opts.gainDb,
          fadeIn: opts.fadeIn,
          fadeOut: opts.fadeOut,
          track: opts.trackId ? { trackId: opts.trackId } : undefined,
          timeline: opts.timeline,
        },
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

timeline
  .command("add-footage")
  .alias("add-clip")
  .description(
    "Append a footage (video) clip — e.g. a phone capture — to a video track; duration auto-probed if omitted",
  )
  .requiredOption("--resource <path>", "absolute path to the video file")
  .option("--duration <frames>", "clip duration in frames (auto-probed if omitted)", parseInteger)
  .option("--in <frame>", "source in-point", parseInteger, 0)
  .option("--track-id <id>", "target video track id")
  .option("--label <label>", "clip label")
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .option("--json", "emit JSON")
  .action(
    async (opts: {
      resource: string;
      duration?: number;
      in: number;
      trackId?: string;
      label?: string;
      timeline?: string;
      json?: boolean;
    }) => {
      const output = await printActionOutput(
        "timeline.addFootage",
        {
          resource: opts.resource,
          durationFrames: opts.duration,
          inFrame: opts.in,
          track: opts.trackId ? { trackId: opts.trackId } : undefined,
          label: opts.label,
          timeline: opts.timeline,
        },
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

function timelineEditInput(
  opOrUri: string,
  maybeOp: string | undefined,
  opts: { timeline?: string; argsJson: string },
) {
  if (maybeOp) return { uri: opOrUri, op: maybeOp, args: parseJson(opts.argsJson) };
  return { timeline: opts.timeline, op: opOrUri, args: parseJson(opts.argsJson) };
}

timeline
  .command("apply-op <op-or-uri> [op-or-alias]")
  .description("Apply an edit operation to a .mlt document; omit URI to use timeline:main")
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .option("--args-json <json>", "operation arguments JSON", assertJson, "{}")
  .option("--json", "emit JSON")
  .action(
    async (
      opOrUri: string,
      maybeOp: string | undefined,
      opts: { timeline?: string; argsJson: string; json?: boolean },
    ) => {
      const output = await printActionOutput(
        "timeline.applyOp",
        timelineEditInput(opOrUri, maybeOp, opts),
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

timeline
  .command("preview-op <op-or-uri> [op-or-alias]")
  .description(
    "Preview an edit operation without mutating the document; omit URI to use timeline:main",
  )
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .option("--args-json <json>", "operation arguments JSON", assertJson, "{}")
  .option("--json", "emit JSON")
  .action(
    async (
      opOrUri: string,
      maybeOp: string | undefined,
      opts: { timeline?: string; argsJson: string; json?: boolean },
    ) => {
      const output = await printActionOutput(
        "timeline.previewOp",
        timelineEditInput(opOrUri, maybeOp, opts),
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

timeline
  .command("undo [uri]")
  .description("Undo an edit by applying a prior inverse invocation")
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .requiredOption("--inverse-json <json>", "inverse invocation JSON", assertJson)
  .option("--json", "emit JSON")
  .action(
    async (
      uri: string | undefined,
      opts: { timeline?: string; inverseJson: string; json?: boolean },
    ) => {
      const output = await printActionOutput(
        "timeline.undo",
        { uri, timeline: opts.timeline, inverse: parseJson(opts.inverseJson) },
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

timeline
  .command("diagnose [uri]")
  .description("Return the full diagnostic set for a .mlt document")
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .option("--json", "emit JSON")
  .action(async (uri: string | undefined, opts: { timeline?: string; json?: boolean }) => {
    const output = await printActionOutput(
      "timeline.diagnose",
      { uri, timeline: opts.timeline },
      opts.json,
    );
    if (!opts.json) printJson(output);
  });

timeline
  .command("resolve-value-at-frame <frame-or-uri> [frame]")
  .description("Resolve a parameter's effective value at a timeline frame")
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .requiredOption("--target-json <json>", "ResolveTarget JSON", assertJson)
  .option("--json", "emit JSON")
  .action(
    async (
      frameOrUri: string,
      frame: string | undefined,
      opts: { timeline?: string; targetJson: string; json?: boolean },
    ) => {
      const input = frame
        ? { uri: frameOrUri, frame: parseInteger(frame), target: parseJson(opts.targetJson) }
        : {
            timeline: opts.timeline,
            frame: parseInteger(frameOrUri),
            target: parseJson(opts.targetJson),
          };
      const output = await printActionOutput("timeline.resolveValueAtFrame", input, opts.json);
      if (!opts.json) printJson(output);
    },
  );

timeline
  .command("find-references [uri]")
  .description("Find references in a .mlt document")
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .requiredOption("--query-json <json>", "ReferenceQuery JSON", assertJson)
  .option("--json", "emit JSON")
  .action(
    async (
      uri: string | undefined,
      opts: { timeline?: string; queryJson: string; json?: boolean },
    ) => {
      const output = await printActionOutput(
        "timeline.findReferences",
        { uri, timeline: opts.timeline, query: parseJson(opts.queryJson) },
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

const renderCommand = program.command("render").description("Render or inspect timeline artifacts");

renderCommand
  .command("video <uri>")
  .description("Render a .mlt document to a video file")
  .requiredOption("--out <path>", "output video path")
  .option("--json", "emit JSON")
  .action(async (uri: string, opts: { out: string; json?: boolean }) => {
    const output = await printActionOutput("render.video", { uri, out: opts.out }, opts.json);
    if (!opts.json) printJson(output);
  });

renderCommand
  .command("still <uri> <frame>")
  .description("Grab one exact frame as a PNG")
  .requiredOption("--out <path>", "output PNG path")
  .option("--json", "emit JSON")
  .action(async (uri: string, frame: string, opts: { out: string; json?: boolean }) => {
    const output = await printActionOutput(
      "render.still",
      { uri, frame: parseInteger(frame), out: opts.out },
      opts.json,
    );
    if (!opts.json) printJson(output);
  });

program
  .command("preview")
  .alias("serve")
  .description(
    "Launch the local 127.0.0.1 web viewer: timeline strip + footage-proxy/Remotion-overlay composited preview on one master clock",
  )
  .option("--timeline <uri-or-route>", "timeline path, file:// URI, or route alias")
  .option("--port <n>", "port to bind on 127.0.0.1", parseInteger, 5174)
  .option("--no-open", "do not open the browser")
  .option("--dev", "reverse-proxy the Vite dev server instead of serving viewer/dist")
  .option("--repo <path>", "project repo path")
  .action(
    async (opts: {
      timeline?: string;
      port: number;
      open?: boolean;
      dev?: boolean;
      repo?: string;
    }) => {
      // Print the URL up front (the action then blocks until Ctrl-C).
      console.error(`vean preview serving on http://127.0.0.1:${opts.port}`);
      console.error(
        opts.dev
          ? "  mode: vite dev proxy (run `bun run viewer:dev` alongside)"
          : "  mode: viewer/dist",
      );
      console.error("  press Ctrl-C to stop");
      await runAction("preview.serve", {
        timeline: opts.timeline,
        port: opts.port,
        open: opts.open !== false,
        dev: opts.dev ?? false,
        repo: opts.repo,
      });
    },
  );

program
  .command("open [project]")
  .description("Open the vean editor on a project — the native app (default) or a browser")
  .option("--view <surface>", "app or browser", "app")
  .option(
    "--dev",
    "for the app: the hot-reloading dev build (tauri:dev) instead of the installed app",
  )
  .option("--port <n>", "for the browser view: port to bind on 127.0.0.1", parseInteger, 5174)
  .action(
    async (project: string | undefined, opts: { view: string; dev?: boolean; port: number }) => {
      // Select the project so the app/preview boots straight at it (the app reads
      // the persisted active project at startup).
      const used = (await runAction("project.use", { project })) as {
        activeProject: { rootPath: string; title: string | null };
      };
      const root = used.activeProject.rootPath;
      const label = used.activeProject.title ?? root;

      if (opts.view === "browser") {
        console.error(`vean: opening ${label} in the browser on http://127.0.0.1:${opts.port} …`);
        await runAction("preview.serve", { repo: root, port: opts.port, open: true });
        return;
      }
      if (opts.view !== "app") {
        throw new InvalidArgumentError("expected --view app or browser");
      }

      const appDir = join(import.meta.dir, "..", "app");
      const launchDev = () => {
        console.error(
          `vean: launching the dev app on ${label} (tauri:dev — first compile is slow) …`,
        );
        Bun.spawn(["bun", "run", "tauri:dev"], {
          cwd: appDir,
          stdout: "inherit",
          stderr: "inherit",
        });
      };
      if (opts.dev) return launchDev();
      const prodApp = "/Applications/vean.app";
      if (existsSync(prodApp)) {
        console.error(`vean: opening the app on ${label} …`);
        Bun.spawn(["open", prodApp], { stdout: "ignore", stderr: "ignore" });
      } else {
        console.error(
          "vean: no installed app (build one with `bun run app:build`) — using the dev app …",
        );
        launchDev();
      }
    },
  );

const remotionCommand = program
  .command("remotion")
  .description("Drive the Remotion producer (arm's-length subprocess)");

remotionCommand
  .command("render <composition>")
  .description("Render a Remotion composition to an alpha ProRes 4444 clip (cached)")
  .option("--props-json <json>", "composition props JSON", assertJson, "{}")
  .option("--frames <start-end>", "inclusive frame range, e.g. 0-89")
  .option("--out <path>", "output .mov path (default: cache path)")
  .option("--profile <name>", "target profile for the cache fingerprint", "vertical")
  .option("--repo <path>", "project repo path")
  .option("--force", "bypass the render cache")
  .option("--json", "emit JSON")
  .action(
    async (
      composition: string,
      opts: {
        propsJson: string;
        frames?: string;
        out?: string;
        profile: string;
        repo?: string;
        force?: boolean;
        json?: boolean;
      },
    ) => {
      let frameRange: [number, number] | undefined;
      if (opts.frames) {
        const m = /^(\d+)-(\d+)$/.exec(opts.frames.trim());
        if (!m) throw new InvalidArgumentError("expected a frame range like 0-89");
        frameRange = [Number.parseInt(m[1] as string, 10), Number.parseInt(m[2] as string, 10)];
      }
      const output = await printActionOutput(
        "remotion.render",
        {
          composition,
          props: parseJson(opts.propsJson),
          frameRange,
          out: opts.out,
          profile: opts.profile,
          repo: opts.repo,
          force: opts.force ?? false,
        },
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

const media = program.command("media").description("Manage project media catalog and roots");
const mediaRoot = media.command("root").description("Manage media roots");

mediaRoot
  .command("add <path>")
  .description("Register a media root")
  .option("--role <role>", "media root role", "raw")
  .option("--policy-json <json>", "root policy JSON", assertJson, "{}")
  .option("--no-route", "do not create/update the default media:<role> route alias")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(
    async (
      path: string,
      opts: { role: string; policyJson: string; route?: boolean; repo?: string; json?: boolean },
    ) => {
      const output = await printActionOutput(
        "media.root.add",
        {
          path,
          role: opts.role,
          policyJson: opts.policyJson,
          setRoute: opts.route !== false,
          repo: opts.repo,
        },
        opts.json,
      );
      if (!opts.json) printJson(output);
    },
  );

mediaRoot
  .command("list")
  .description("List media roots")
  .option("--role <role>", "filter by media root role")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (opts: { role?: string; repo?: string; json?: boolean }) => {
    const output = await printActionOutput("media.root.list", opts, opts.json);
    if (!opts.json) printJson(output);
  });

mediaRoot
  .command("remove <id>")
  .description("Remove a media root and its cataloged assets")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (id: string, opts: { repo?: string; json?: boolean }) => {
    const output = await printActionOutput("media.root.remove", { ...opts, id }, opts.json);
    if (!opts.json) printJson(output);
  });

media
  .command("scan")
  .description("Scan a media root and catalog lightweight metadata")
  .option("--root-id <id>", "media root id to scan")
  .option("--limit <n>", "maximum files to catalog", parseInteger, 1000)
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (opts: { rootId?: string; limit: number; repo?: string; json?: boolean }) => {
    const output = await printActionOutput("media.scan", opts, opts.json);
    if (!opts.json) printJson(output);
  });

media
  .command("probe")
  .description("ffprobe media (duration/fps/resolution/audio) and cache it on the catalog row")
  .option("--id <id>", "probe one cataloged asset by id")
  .option("--path <path>", "probe an arbitrary file path (not cataloged)")
  .option("--all", "probe every un-probed cataloged asset")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(
    async (opts: { id?: string; path?: string; all?: boolean; repo?: string; json?: boolean }) => {
      const output = await printActionOutput("media.probe", opts, opts.json);
      if (!opts.json) printJson(output);
    },
  );

media
  .command("list")
  .description("List cataloged media assets")
  .option("--kind <kind>", "filter by kind: video, audio, image, timeline, unknown")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (opts: { kind?: string; repo?: string; json?: boolean }) => {
    const output = await printActionOutput("media.list", opts, opts.json);
    if (!opts.json) printJson(output);
  });

media
  .command("find <query>")
  .description("Find cataloged media assets by relative path")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (query: string, opts: { repo?: string; json?: boolean }) => {
    const output = await printActionOutput("media.find", { ...opts, query }, opts.json);
    if (!opts.json) printJson(output);
  });

const route = program.command("route").description("Manage project route aliases");

route
  .command("set <alias> <target>")
  .description("Set a route alias")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (alias: string, target: string, opts: { repo?: string; json?: boolean }) => {
    const output = await printActionOutput("route.set", { ...opts, alias, target }, opts.json);
    if (!opts.json) printJson(output);
  });

route
  .command("list")
  .description("List route aliases")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const output = await printActionOutput("route.list", opts, opts.json);
    if (!opts.json) printJson(output);
  });

route
  .command("resolve <alias>")
  .description("Resolve a route alias")
  .option("--repo <path>", "project repo path")
  .option("--json", "emit JSON")
  .action(async (alias: string, opts: { repo?: string; json?: boolean }) => {
    const output = await printActionOutput("route.resolve", { ...opts, alias }, opts.json);
    if (!opts.json) printJson(output);
  });

const state = program.command("state").description("Manage repo-local vean state in .vean/");

state
  .command("init")
  .description("Create .vean/vean.db and run local state migrations")
  .option("--repo <path>", "repo path to initialize")
  .option("--json", "emit JSON")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const status = (await printActionOutput("state.init", opts, opts.json)) as {
      dbPath: string;
      migrationsApplied: number;
    };
    if (!opts.json) {
      console.log(`Initialized vean state at ${status.dbPath}`);
      console.log(`Migrations applied: ${status.migrationsApplied}`);
    }
  });

state
  .command("status")
  .description("Inspect repo-local vean state without mutating it")
  .option("--repo <path>", "repo path to inspect")
  .option("--json", "emit JSON")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const status = (await printActionOutput("state.status", opts, opts.json)) as {
      exists: boolean;
      dbPath: string;
      migrationsApplied: number;
      journalMode?: string;
      busyTimeoutMs?: number;
    };
    if (!opts.json) {
      console.log(`${status.exists ? "OK" : "MISSING"} state: ${status.dbPath}`);
      console.log(`Migrations applied: ${status.migrationsApplied}`);
      if (status.journalMode) console.log(`Journal mode: ${status.journalMode}`);
      if (status.busyTimeoutMs !== undefined)
        console.log(`Busy timeout: ${status.busyTimeoutMs}ms`);
    }
  });

const project = program.command("project").description("Manage vean projects");

project
  .command("init")
  .description("Initialize .vean state and register this repo as a project")
  .option("--repo <path>", "repo path to initialize")
  .option("--json", "emit JSON")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const output = (await runAction("project.init", opts)) as {
      project: { id: string; rootPath: string; title?: string | null };
    };
    if (opts.json) printJson(output.project);
    if (!opts.json) {
      console.log(
        `Initialized vean project ${output.project.title ?? output.project.id} at ${
          output.project.rootPath
        }`,
      );
    }
  });

project
  .command("use [project]")
  .description("Select a project for future project-aware commands")
  .option("--json", "emit JSON")
  .action(async (projectPath: string | undefined, opts: { json?: boolean }) => {
    const output = (await printActionOutput(
      "project.use",
      { project: projectPath },
      opts.json,
    )) as { activeProject: { rootPath: string; title: string | null } };
    if (!opts.json) {
      console.log(
        `Using vean project ${output.activeProject.title ?? output.activeProject.rootPath} at ${
          output.activeProject.rootPath
        }`,
      );
    }
  });

project
  .command("list")
  .description("List known projects")
  .option("--json", "emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const output = (await printActionOutput("project.list", {}, opts.json)) as {
      projects: Array<{ id: string; rootPath: string; title: string | null; lastUsedAt: string }>;
    };
    if (!opts.json) {
      if (output.projects.length === 0) console.log("No known projects");
      else {
        for (const p of output.projects) {
          console.log(`${p.id}\t${p.title ?? ""}\t${p.rootPath}\t${p.lastUsedAt}`);
        }
      }
    }
  });

project
  .command("current")
  .description("Resolve the current project")
  .option("--project <id-or-path>", "project id or path to resolve")
  .option("--json", "emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const output = (await printActionOutput(
      "project.current",
      { project: opts.project },
      opts.json,
    )) as { project: { rootPath: string; source: string } | null };
    if (!opts.json) {
      if (!output.project) console.log("No current project");
      else console.log(`${output.project.rootPath} (${output.project.source})`);
    }
  });

project
  .command("status")
  .description("Resolve a project and inspect its local state")
  .option("--project <id-or-path>", "project id or path to inspect")
  .option("--json", "emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const output = (await printActionOutput(
      "project.status",
      { project: opts.project },
      opts.json,
    )) as {
      project: { rootPath: string; source: string } | null;
      state: { exists: boolean } | null;
    };
    if (!opts.json) {
      if (!output.project) console.log("No current project");
      else
        console.log(
          `${output.project.rootPath} (${output.project.source}) state=${output.state?.exists}`,
        );
    }
  });

project
  .command("doctor")
  .description("Run vean doctor scoped to the resolved project")
  .option("--project <id-or-path>", "project id or path")
  .option(
    "--surface <surface>",
    "tool surface: all, cli, lsp, mcp, cli-lsp, mcp-lsp",
    parseSurface,
    "cli-lsp",
  )
  .option("--json", "emit JSON")
  .action(async (opts: { project?: string; surface?: DoctorSurface; json?: boolean }) => {
    const current = (await runAction("project.current", { project: opts.project })) as {
      project: { rootPath: string } | null;
    };
    const repo = current.project?.rootPath;
    if (!repo) {
      console.error("No project resolved — run `vean project use <path>` first");
      process.exit(1);
    }
    const report = await runAction("setup.doctor", { repo, surface: opts.surface, host: "all" });
    if (opts.json) printJson(report);
    else console.log(formatDoctorReport(report as never));
    process.exit((report as { ok: boolean }).ok ? 0 : 1);
  });

project
  .command("open")
  .description("Reveal the resolved project's root folder in the OS file manager")
  .option("--project <id-or-path>", "project id or path")
  .action(async (opts: { project?: string }) => {
    const current = (await runAction("project.current", { project: opts.project })) as {
      project: { rootPath: string } | null;
    };
    const repo = current.project?.rootPath;
    if (!repo) {
      console.error("No project resolved — run `vean project use <path>` first");
      process.exit(1);
    }
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    Bun.spawn([opener, repo], { stdout: "ignore", stderr: "ignore" });
    console.log(`Opening ${repo}`);
  });

const jobsCommand = program.command("jobs").description("Inspect and manage local vean jobs");

jobsCommand
  .command("list")
  .description("List jobs recorded in .vean/vean.db")
  .option("--repo <path>", "repo path to inspect")
  .option("--json", "emit JSON")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const jobs = (await printActionOutput("jobs.list", opts, opts.json)) as Array<{
      id: string;
      status: string;
      kind: string;
      createdAt: string;
    }>;
    if (!opts.json) {
      if (jobs.length === 0) console.log("No jobs");
      else {
        for (const job of jobs) {
          console.log(`${job.id}\t${job.status}\t${job.kind}\t${job.createdAt}`);
        }
      }
    }
  });

jobsCommand
  .command("enqueue <kind>")
  .description("Create a queued local job")
  .option("--repo <path>", "repo path to use")
  .option("--payload-json <json>", "job payload JSON", assertJson, "{}")
  .option("--priority <n>", "job priority", parseInteger, 0)
  .option("--max-attempts <n>", "maximum attempts", parseInteger, 3)
  .option("--json", "emit JSON")
  .action(
    async (
      kind: string,
      opts: {
        repo?: string;
        payloadJson: string;
        priority: number;
        maxAttempts: number;
        json?: boolean;
      },
    ) => {
      const job = (await printActionOutput("jobs.enqueue", { ...opts, kind }, opts.json)) as {
        id: string;
        kind: string;
      };
      if (!opts.json) console.log(`Queued ${job.id} (${job.kind})`);
    },
  );

jobsCommand
  .command("claim")
  .description("Claim the next queued job with a short lease")
  .requiredOption("--worker <id>", "worker id claiming the job")
  .option("--repo <path>", "repo path to use")
  .option("--lease-ms <n>", "lease duration in milliseconds", parseInteger, 60_000)
  .option("--json", "emit JSON")
  .action(async (opts: { repo?: string; worker: string; leaseMs: number; json?: boolean }) => {
    const job = (await printActionOutput("jobs.claim", opts, opts.json)) as
      | { id: string; kind: string; lockedUntil: string }
      | undefined;
    if (!opts.json) {
      if (job) console.log(`Claimed ${job.id} (${job.kind}) until ${job.lockedUntil}`);
      else console.log("No queued job available");
    }
  });

jobsCommand
  .command("complete <id>")
  .description("Mark a local job done")
  .option("--repo <path>", "repo path to use")
  .option("--result-json <json>", "result JSON", assertJson, "{}")
  .option("--json", "emit JSON")
  .action(async (id: string, opts: { repo?: string; resultJson: string; json?: boolean }) => {
    const job = (await printActionOutput("jobs.complete", { ...opts, id }, opts.json)) as
      | { id: string }
      | undefined;
    if (!opts.json) {
      if (!job) throw new Error(`Job not found: ${id}`);
      console.log(`Completed ${job.id}`);
    }
  });

jobsCommand
  .command("fail <id>")
  .description("Mark a local job failed")
  .requiredOption("--error <message>", "failure message")
  .option("--repo <path>", "repo path to use")
  .option("--json", "emit JSON")
  .action(async (id: string, opts: { repo?: string; error: string; json?: boolean }) => {
    const job = (await printActionOutput("jobs.fail", { ...opts, id }, opts.json)) as
      | { id: string }
      | undefined;
    if (!opts.json) {
      if (!job) throw new Error(`Job not found: ${id}`);
      console.log(`Failed ${job.id}`);
    }
  });

program.addCommand(buildConfigCommand());
program.addCommand(buildFpsCommand());

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
