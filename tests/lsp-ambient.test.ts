// The AMBIENT-FEEDBACK gate (Move 2). The load-bearing proof that `vean-lsp`
// behaves like a real language server: a document change PUSHES the current
// diagnostic set into the client via `publishDiagnostics`, with NO manual
// `diagnose` call anywhere in the path (AGENTS.md "Agent feedback contract"; the
// explicit BUILD-MONITOR escalation trigger is "diagnose becomes the required
// safety step after ordinary edits" — this test guards against exactly that).
//
// Two layers of proof, strongest first:
//  1. PROTOCOL layer — drive the ACTUAL server handlers (`registerHandlers`) over
//     a real paired JSON-RPC connection (two in-memory duplex streams). A
//     `textDocument/didOpen` makes the server send `textDocument/publishDiagnostics`;
//     a `didChange` that fixes the defect sends an EMPTY set (clears). This proves
//     the real LSP wire behavior, not a hand-call of the engine.
//  2. ENGINE layer — the same path the handler runs (`analyze`), asserted directly
//     for the precise diagnostic codes, source mapping (text ranges), and code
//     actions. Cheaper + exact.
//
// The rules are NEVER reimplemented here — the LSP engine calls the SHARED
// `collectDiagnostics` (src/diagnostics). This test imports the bridge, never a
// diagnostics rule.
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  type Connection,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocuments,
  createConnection,
} from "vscode-languageserver/node";
import { codeActions } from "../src/bridge/lsp/codeActions";
import { analyze } from "../src/bridge/lsp/engine";
import { registerHandlers } from "../src/bridge/lsp/server";

const URI = "file:///ambient.mlt";

// A defective .mlt: clip window out=200 past its source length=100 → the shared
// engine's `in-out-beyond-source` ERROR. The serializer would never EMIT this
// (it's an unserializable state), but it is a real broken file an agent could
// open or produce mid-edit — exactly what the ambient loop must surface.
const BROKEN = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" root="" title="broken">
  <profile description="x" width="1080" height="1920" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="9" display_aspect_den="16" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="200">
    <property name="length">100</property>
    <property name="mlt_service">color</property>
    <property name="resource">#FF000000</property>
    <property name="shotcut:uuid">badclip</property>
  </producer>
  <playlist id="playlist0">
    <property name="shotcut:video">1</property>
    <property name="shotcut:audio">0</property>
    <property name="shotcut:name">V1</property>
    <entry producer="producer0" in="0" out="200"/>
  </playlist>
  <tractor id="tractor0" shotcut="1" title="broken">
    <track producer="playlist0"/>
  </tractor>
</mlt>`;

// The same document with the clip window clamped to its source — the FIX. The
// played window comes from the entry, so the in-bounds value is the entry's
// out="99". Re-analysis must come back clean (the pushed set clears).
const FIXED = BROKEN.replace(
  '<entry producer="producer0" in="0" out="200"/>',
  '<entry producer="producer0" in="0" out="99"/>',
);

// ─── A paired in-memory LSP harness ─────────────────────────────────────────
/** Wire the REAL server over a pair of in-memory duplex streams, with a client
 *  connection on the other end that records every `publishDiagnostics`. This is
 *  the actual JSON-RPC protocol — no shortcut. Returns the client + the recorded
 *  pushes + a disposer. */
type Pushed = { uri: string; diagnostics: Array<{ code?: string | number }> };
function harness(): {
  client: Connection;
  pushed: Pushed[];
  dispose: () => void;
} {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const server = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
  const documents = new TextDocuments(TextDocument);
  registerHandlers(server, documents);
  documents.listen(server);
  server.listen();

  const client = createConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
  const pushed: Pushed[] = [];
  client.onNotification("textDocument/publishDiagnostics", (p: Pushed) => {
    pushed.push(p);
  });
  client.listen();

  return {
    client,
    pushed,
    dispose: () => {
      client.dispose();
      server.dispose();
    },
  };
}

/** Settle the event loop so an in-flight notification is delivered. */
function settle(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("vean-lsp — ambient publishDiagnostics over the real protocol", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("PUSHES the known defect on didOpen, with NO manual diagnose call", async () => {
    const h = harness();
    dispose = h.dispose;
    await h.client.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    // A bare document OPEN — the only trigger. There is no diagnose request in this
    // test at all; the diagnostic arrives purely because the document changed.
    h.client.sendNotification("textDocument/didOpen", {
      textDocument: { uri: URI, languageId: "mlt", version: 1, text: BROKEN },
    });
    await settle();

    expect(h.pushed.length).toBeGreaterThanOrEqual(1);
    const last = h.pushed.at(-1);
    expect(last?.uri).toBe(URI);
    const codes = last?.diagnostics.map((d) => d.code) ?? [];
    expect(codes).toContain("in-out-beyond-source");
  });

  it("CLEARS the pushed set when a didChange fixes the defect (empty publish)", async () => {
    const h = harness();
    dispose = h.dispose;
    await h.client.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    h.client.sendNotification("textDocument/didOpen", {
      textDocument: { uri: URI, languageId: "mlt", version: 1, text: BROKEN },
    });
    await settle();
    // The fix arrives as a normal document change — again, no diagnose call.
    h.client.sendNotification("textDocument/didChange", {
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: FIXED }],
    });
    await settle();

    const last = h.pushed.at(-1);
    expect(last?.uri).toBe(URI);
    expect(last?.diagnostics).toEqual([]); // empty set clears prior diagnostics
  });
});

describe("vean-lsp engine — diagnostic source mapping + code actions", () => {
  it("maps the stable-identity location to a real text range in the document", () => {
    const a = analyze(URI, BROKEN);
    expect(a.lspDiagnostics).toHaveLength(1);
    const d = a.lspDiagnostics[0];
    expect(d?.code).toBe("in-out-beyond-source");
    // The range is non-degenerate and anchored INSIDE the document (the producer
    // element on line 3+), not the (0,0) head fallback — source mapping resolved it.
    expect(d?.range.start.line).toBeGreaterThan(0);
    expect(d?.range.end.line).toBeGreaterThanOrEqual(d?.range.start.line ?? 0);
  });

  it("offers a deterministic code-action fix that, applied, clears the diagnostic", () => {
    const a = analyze(URI, BROKEN);
    const target = a.lspDiagnostics.find((d) => d.code === "in-out-beyond-source");
    expect(target).toBeDefined();
    const actions = codeActions(
      a,
      (
        target as {
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        }
      ).range,
    );
    expect(actions.length).toBeGreaterThanOrEqual(1);
    const action = actions[0];
    expect(action?.title).toMatch(/Trim out-point to 99/);

    // Apply the action's TextEdit to the source and re-analyze: clean.
    const edit = action?.edit?.changes?.[URI]?.[0];
    expect(edit).toBeDefined();
    const doc = TextDocument.create(URI, "mlt", 1, BROKEN);
    const start = doc.offsetAt(
      (edit as { range: { start: import("vscode-languageserver").Position } }).range.start,
    );
    const end = doc.offsetAt(
      (edit as { range: { end: import("vscode-languageserver").Position } }).range.end,
    );
    const newText = (edit as { newText: string }).newText;
    const repaired = BROKEN.slice(0, start) + newText + BROKEN.slice(end);
    const after = analyze(URI, repaired);
    expect(after.lspDiagnostics).toEqual([]);
  });

  it("a clean corpus document yields ZERO diagnostics (an empty publish set)", async () => {
    // vitest runs under Node (no Bun global) — read via node:fs.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const text = readFileSync(
      resolve(import.meta.dirname, "..", "corpus", "vean-multitrack.mlt"),
      "utf8",
    );
    const a = analyze("file:///corpus/vean-multitrack.mlt", text);
    expect(a.lspDiagnostics).toEqual([]);
  });

  it("a malformed (unparseable) document surfaces a parse-error diagnostic, not a crash", () => {
    const a = analyze(URI, "<mlt>not really</mlt>");
    // It must still PUBLISH something (a parse failure is a real, visible defect),
    // never throw — the ambient loop has to be crash-proof.
    expect(a.lspDiagnostics.length).toBeGreaterThanOrEqual(1);
    expect(a.lspDiagnostics.some((d) => d.code === "parse-error")).toBe(true);
  });
});
