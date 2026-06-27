import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { openStateDb } from "./db";
import { jobs } from "./schema";

export type JobRecord = typeof jobs.$inferSelect;
export type NewJob = {
  kind: string;
  payloadJson?: string;
  priority?: number;
  maxAttempts?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function enqueueJob(repo: string, input: NewJob): JobRecord {
  const handle = openStateDb(repo);
  try {
    return handle.db
      .insert(jobs)
      .values({
        id: randomUUID(),
        kind: input.kind,
        payloadJson: input.payloadJson ?? "{}",
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 3,
      })
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function claimNextJob(
  repo: string,
  workerId: string,
  leaseMs = 60_000,
): JobRecord | undefined {
  const handle = openStateDb(repo);
  try {
    return handle.db.transaction((tx) => {
      const now = nowIso();
      const candidate = tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "queued"),
            or(isNull(jobs.lockedUntil), lt(jobs.lockedUntil, now)),
            lt(jobs.attempts, jobs.maxAttempts),
          ),
        )
        .orderBy(desc(jobs.priority), jobs.createdAt)
        .limit(1)
        .get();
      if (!candidate) return undefined;
      return tx
        .update(jobs)
        .set({
          status: "running",
          lockedBy: workerId,
          lockedUntil: futureIso(leaseMs),
          attempts: sql`${jobs.attempts} + 1`,
          startedAt: candidate.startedAt ?? now,
          updatedAt: now,
        })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
        .returning()
        .get();
    });
  } finally {
    handle.sqlite.close();
  }
}

export function completeJob(repo: string, id: string, resultJson = "{}"): JobRecord | undefined {
  const handle = openStateDb(repo);
  try {
    const now = nowIso();
    return handle.db
      .update(jobs)
      .set({
        status: "done",
        resultJson,
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(jobs.id, id))
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function failJob(repo: string, id: string, error: string): JobRecord | undefined {
  const handle = openStateDb(repo);
  try {
    const now = nowIso();
    return handle.db
      .update(jobs)
      .set({
        status: "failed",
        error,
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(jobs.id, id))
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function listJobs(repo = process.cwd()): JobRecord[] {
  const handle = openStateDb(repo);
  try {
    return handle.db.select().from(jobs).orderBy(jobs.createdAt).all();
  } finally {
    handle.sqlite.close();
  }
}

export function getJob(repo: string, id: string): JobRecord | undefined {
  const handle = openStateDb(repo);
  try {
    return handle.db.select().from(jobs).where(eq(jobs.id, id)).get();
  } finally {
    handle.sqlite.close();
  }
}
