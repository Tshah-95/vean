export type MediaResourceKind =
  | "audio-context"
  | "decoder-worker"
  | "image-bitmap"
  | "webgl-context";

export interface ResourceLedgerEvent {
  sequence: number;
  operation: "open" | "close";
  kind: MediaResourceKind;
  id: string;
}

export interface ResourceLedgerSnapshot {
  opens: Record<MediaResourceKind, number>;
  closes: Record<MediaResourceKind, number>;
  outstanding: Array<{ kind: MediaResourceKind; id: string }>;
  balanced: boolean;
  events: ResourceLedgerEvent[];
}

const KINDS: MediaResourceKind[] = [
  "audio-context",
  "decoder-worker",
  "image-bitmap",
  "webgl-context",
];

/** Deterministic ownership accounting for application-owned media handles.
 * Browser process memory is measured separately: garbage collection is never
 * allowed to make a missing explicit close look healthy. */
export class MediaResourceLedger {
  private sequence = 0;
  private readonly live = new Set<string>();
  private readonly events: ResourceLedgerEvent[] = [];

  open(kind: MediaResourceKind, id: string): void {
    const key = `${kind}\0${id}`;
    if (this.live.has(key)) throw new Error(`media resource opened twice: ${kind}:${id}`);
    this.live.add(key);
    this.events.push({ sequence: ++this.sequence, operation: "open", kind, id });
  }

  close(kind: MediaResourceKind, id: string): void {
    const key = `${kind}\0${id}`;
    if (!this.live.delete(key))
      throw new Error(`media resource closed without ownership: ${kind}:${id}`);
    this.events.push({ sequence: ++this.sequence, operation: "close", kind, id });
  }

  snapshot(): ResourceLedgerSnapshot {
    const opens = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<
      MediaResourceKind,
      number
    >;
    const closes = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<
      MediaResourceKind,
      number
    >;
    for (const event of this.events) (event.operation === "open" ? opens : closes)[event.kind]++;
    const outstanding = [...this.live]
      .map((key) => {
        const [kind, id] = key.split("\0") as [MediaResourceKind, string];
        return { kind, id };
      })
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    return {
      opens,
      closes,
      outstanding,
      balanced: outstanding.length === 0 && KINDS.every((kind) => opens[kind] === closes[kind]),
      events: [...this.events],
    };
  }
}

declare global {
  interface Window {
    __veanMediaResources?: () => ResourceLedgerSnapshot;
  }
}
