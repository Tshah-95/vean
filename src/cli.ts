#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
import {
  createActionContext,
  describeAction,
  executeAction,
  getAction,
  listActions,
} from "./actions";
import { type DoctorHost, type DoctorSurface, formatDoctorReport } from "./cli/doctor";

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

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function runAction(actionId: string, input: unknown) {
  const envelope = await executeAction(actionId, input, context());
  if (!envelope.ok) {
    throw new Error(`${envelope.kind}: ${envelope.detail}`);
  }
  return envelope.output;
}

async function printActionOutput(
  actionId: string,
  input: unknown,
  json?: boolean,
): Promise<unknown> {
  const output = await runAction(actionId, input);
  if (json) printJson(output);
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

const timeline = program.command("timeline").description("Inspect and edit .mlt timelines");

timeline
  .command("apply-op <uri> <op>")
  .description("Apply an edit operation to a .mlt document")
  .option("--args-json <json>", "operation arguments JSON", assertJson, "{}")
  .option("--json", "emit JSON")
  .action(async (uri: string, op: string, opts: { argsJson: string; json?: boolean }) => {
    const output = await printActionOutput(
      "timeline.applyOp",
      { uri, op, args: parseJson(opts.argsJson) },
      opts.json,
    );
    if (!opts.json) printJson(output);
  });

timeline
  .command("preview-op <uri> <op>")
  .description("Preview an edit operation without mutating the document")
  .option("--args-json <json>", "operation arguments JSON", assertJson, "{}")
  .option("--json", "emit JSON")
  .action(async (uri: string, op: string, opts: { argsJson: string; json?: boolean }) => {
    const output = await printActionOutput(
      "timeline.previewOp",
      { uri, op, args: parseJson(opts.argsJson) },
      opts.json,
    );
    if (!opts.json) printJson(output);
  });

timeline
  .command("undo <uri>")
  .description("Undo an edit by applying a prior inverse invocation")
  .requiredOption("--inverse-json <json>", "inverse invocation JSON", assertJson)
  .option("--json", "emit JSON")
  .action(async (uri: string, opts: { inverseJson: string; json?: boolean }) => {
    const output = await printActionOutput(
      "timeline.undo",
      { uri, inverse: parseJson(opts.inverseJson) },
      opts.json,
    );
    if (!opts.json) printJson(output);
  });

timeline
  .command("diagnose <uri>")
  .description("Return the full diagnostic set for a .mlt document")
  .option("--json", "emit JSON")
  .action(async (uri: string, opts: { json?: boolean }) => {
    const output = await printActionOutput("timeline.diagnose", { uri }, opts.json);
    if (!opts.json) printJson(output);
  });

timeline
  .command("resolve-value-at-frame <uri> <frame>")
  .description("Resolve a parameter's effective value at a timeline frame")
  .requiredOption("--target-json <json>", "ResolveTarget JSON", assertJson)
  .option("--json", "emit JSON")
  .action(async (uri: string, frame: string, opts: { targetJson: string; json?: boolean }) => {
    const output = await printActionOutput(
      "timeline.resolveValueAtFrame",
      { uri, frame: parseInteger(frame), target: parseJson(opts.targetJson) },
      opts.json,
    );
    if (!opts.json) printJson(output);
  });

timeline
  .command("find-references <uri>")
  .description("Find references in a .mlt document")
  .requiredOption("--query-json <json>", "ReferenceQuery JSON", assertJson)
  .option("--json", "emit JSON")
  .action(async (uri: string, opts: { queryJson: string; json?: boolean }) => {
    const output = await printActionOutput(
      "timeline.findReferences",
      { uri, query: parseJson(opts.queryJson) },
      opts.json,
    );
    if (!opts.json) printJson(output);
  });

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

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
