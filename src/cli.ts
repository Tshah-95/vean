#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
import { type DoctorHost, type DoctorSurface, formatDoctorReport, runDoctor } from "./cli/doctor";
import { claimNextJob, completeJob, enqueueJob, failJob, listJobs } from "./state/jobs";
import { getStateStatus, initializeState } from "./state/migrate";
import { initializeProject } from "./state/project";

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

function assertJson(value: string): string {
  try {
    JSON.parse(value);
    return value;
  } catch {
    throw new InvalidArgumentError("expected valid JSON");
  }
}

program.name("vean").description("Agent-native video editing core").version("0.0.0");

program
  .command("doctor")
  .description(
    "Verify local dependencies, agent skills, Claude Code plugin config, and stdio servers",
  )
  .option("--repo <path>", "repo path to inspect", process.cwd())
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
      repo: string;
      host: DoctorHost;
      json?: boolean;
      strict?: boolean;
      probe?: boolean;
      surface?: DoctorSurface;
    }) => {
      const report = await runDoctor(opts);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatDoctorReport(report));
      const hasWarnings = report.checks.some((c) => c.status === "warn");
      process.exit(report.ok && !(opts.strict && hasWarnings) ? 0 : 1);
    },
  );

const state = program.command("state").description("Manage repo-local vean state in .vean/");

state
  .command("init")
  .description("Create .vean/vean.db and run local state migrations")
  .option("--repo <path>", "repo path to initialize", process.cwd())
  .option("--json", "emit JSON")
  .action((opts: { repo: string; json?: boolean }) => {
    const status = initializeState(opts.repo);
    if (opts.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`Initialized vean state at ${status.dbPath}`);
      console.log(`Migrations applied: ${status.migrationsApplied}`);
    }
  });

state
  .command("status")
  .description("Inspect repo-local vean state without mutating it")
  .option("--repo <path>", "repo path to inspect", process.cwd())
  .option("--json", "emit JSON")
  .action((opts: { repo: string; json?: boolean }) => {
    const status = getStateStatus(opts.repo);
    if (opts.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`${status.exists ? "OK" : "MISSING"} state: ${status.dbPath}`);
      console.log(`Migrations applied: ${status.migrationsApplied}`);
      if (status.journalMode) console.log(`Journal mode: ${status.journalMode}`);
      if (status.busyTimeoutMs !== undefined)
        console.log(`Busy timeout: ${status.busyTimeoutMs}ms`);
    }
  });

program
  .command("project")
  .description("Manage the current vean project")
  .command("init")
  .description("Initialize .vean state and register this repo as a project")
  .option("--repo <path>", "repo path to initialize", process.cwd())
  .option("--json", "emit JSON")
  .action((opts: { repo: string; json?: boolean }) => {
    const project = initializeProject(opts.repo);
    if (opts.json) console.log(JSON.stringify(project, null, 2));
    else
      console.log(`Initialized vean project ${project.title ?? project.id} at ${project.rootPath}`);
  });

const jobsCommand = program.command("jobs").description("Inspect and manage local vean jobs");

jobsCommand
  .command("list")
  .description("List jobs recorded in .vean/vean.db")
  .option("--repo <path>", "repo path to inspect", process.cwd())
  .option("--json", "emit JSON")
  .action((opts: { repo: string; json?: boolean }) => {
    const jobs = listJobs(opts.repo);
    if (opts.json) console.log(JSON.stringify(jobs, null, 2));
    else if (jobs.length === 0) console.log("No jobs");
    else {
      for (const job of jobs) {
        console.log(`${job.id}\t${job.status}\t${job.kind}\t${job.createdAt}`);
      }
    }
  });

jobsCommand
  .command("enqueue <kind>")
  .description("Create a queued local job")
  .option("--repo <path>", "repo path to use", process.cwd())
  .option("--payload-json <json>", "job payload JSON", assertJson, "{}")
  .option("--priority <n>", "job priority", parseInteger, 0)
  .option("--max-attempts <n>", "maximum attempts", parseInteger, 3)
  .option("--json", "emit JSON")
  .action(
    (
      kind: string,
      opts: {
        repo: string;
        payloadJson: string;
        priority: number;
        maxAttempts: number;
        json?: boolean;
      },
    ) => {
      const job = enqueueJob(opts.repo, {
        kind,
        payloadJson: opts.payloadJson,
        priority: opts.priority,
        maxAttempts: opts.maxAttempts,
      });
      if (opts.json) console.log(JSON.stringify(job, null, 2));
      else console.log(`Queued ${job.id} (${job.kind})`);
    },
  );

jobsCommand
  .command("claim")
  .description("Claim the next queued job with a short lease")
  .requiredOption("--worker <id>", "worker id claiming the job")
  .option("--repo <path>", "repo path to use", process.cwd())
  .option("--lease-ms <n>", "lease duration in milliseconds", parseInteger, 60_000)
  .option("--json", "emit JSON")
  .action((opts: { repo: string; worker: string; leaseMs: number; json?: boolean }) => {
    const job = claimNextJob(opts.repo, opts.worker, opts.leaseMs);
    if (opts.json) console.log(JSON.stringify(job ?? null, null, 2));
    else if (job) console.log(`Claimed ${job.id} (${job.kind}) until ${job.lockedUntil}`);
    else console.log("No queued job available");
  });

jobsCommand
  .command("complete <id>")
  .description("Mark a local job done")
  .option("--repo <path>", "repo path to use", process.cwd())
  .option("--result-json <json>", "result JSON", assertJson, "{}")
  .option("--json", "emit JSON")
  .action((id: string, opts: { repo: string; resultJson: string; json?: boolean }) => {
    const job = completeJob(opts.repo, id, opts.resultJson);
    if (opts.json) console.log(JSON.stringify(job ?? null, null, 2));
    else if (job) console.log(`Completed ${job.id}`);
    else {
      console.error(`Job not found: ${id}`);
      process.exit(1);
    }
  });

jobsCommand
  .command("fail <id>")
  .description("Mark a local job failed")
  .requiredOption("--error <message>", "failure message")
  .option("--repo <path>", "repo path to use", process.cwd())
  .option("--json", "emit JSON")
  .action((id: string, opts: { repo: string; error: string; json?: boolean }) => {
    const job = failJob(opts.repo, id, opts.error);
    if (opts.json) console.log(JSON.stringify(job ?? null, null, 2));
    else if (job) console.log(`Failed ${job.id}`);
    else {
      console.error(`Job not found: ${id}`);
      process.exit(1);
    }
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
