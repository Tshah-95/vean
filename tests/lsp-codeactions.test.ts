// vean-lsp CODE-ACTION gate. Proves the "Code actions are fixes" contract
// (AGENTS.md "Agent feedback contract", BUILD-MONITOR review lens): a diagnostic
// with a deterministic repair exposes an LSP code action whose `WorkspaceEdit`,
// applied to the `.mlt` text, makes RE-ANALYSIS clear that diagnostic — the same
// loop the ambient server runs (`onDidChangeContent` after a WorkspaceEdit →
// `publishDiagnostics`).
//
// The rules are NEVER reimplemented here: the code actions read only the SHARED
// engine's diagnostic (`code` + `data`) + the source map. This file imports the
// bridge (`analyze`, `codeActions`), never a diagnostics rule. Each repair is
// reachable through the LSP DOCUMENT path (a parseable `.mlt`); a defect the IR
// schema rejects (negative in-point, empty resource) surfaces as a parse-error and
// is intentionally NOT a quick-fix (its repair, if any, is the MCP op layer's).
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  type CodeAction,
  type Connection,
  Position,
  type Range,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocuments,
  createConnection,
} from "vscode-languageserver/node";
import { codeActions } from "../src/bridge/lsp/codeActions";
import { analyze } from "../src/bridge/lsp/engine";
import { registerHandlers } from "../src/bridge/lsp/server";

const URI = "file:///ca.mlt";

const HEAD = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" root="" title="ca">
  <profile description="x" width="1080" height="1920" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="9" display_aspect_den="16" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>`;

// A clip window past its source length (out=200, length=100) — the seeded
// `in-out-beyond-source` ERROR. The played window comes from the <entry>, so the
// fix rewrites the entry's out → 99.
const BEYOND_SOURCE = `${HEAD}
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
  <tractor id="tractor0" shotcut="1" title="ca">
    <track producer="playlist0"/>
  </tractor>
</mlt>`;

/** A two-video-track doc with a field transition whose window is `[trIn, trOut]`. */
function twoTrackTransition(trIn: number, trOut: number): string {
  return `${HEAD}
  <producer id="p0" in="0" out="24">
    <property name="length">25</property><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="shotcut:uuid">c0</property>
  </producer>
  <producer id="p1" in="0" out="24">
    <property name="length">25</property><property name="mlt_service">color</property><property name="resource">#FFFFD700</property><property name="shotcut:uuid">c1</property>
  </producer>
  <playlist id="playlist0"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><property name="shotcut:name">V1</property>
    <entry producer="p0" in="0" out="24"/></playlist>
  <playlist id="playlist1"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><property name="shotcut:name">V2</property>
    <entry producer="p1" in="0" out="24"/></playlist>
  <tractor id="tractor1" shotcut="1" title="ca">
    <track producer="playlist0"/><track producer="playlist1"/>
    <transition id="transition0" mlt_service="qtblend" in="${trIn}" out="${trOut}">
      <property name="a_track">1</property><property name="b_track">2</property>
    </transition>
  </tractor>
</mlt>`;
}

/** Apply a code action's WorkspaceEdit to the source text (edits applied
 *  right-to-left by offset so earlier edits don't shift later ones). The exact
 *  transform an LSP client performs on accepting the quick-fix. */
function applyAction(
  text: string,
  action: { edit?: { changes?: Record<string, unknown> } },
): string {
  const doc = TextDocument.create(URI, "mlt", 1, text);
  const edits = (action.edit?.changes?.[URI] ?? []) as Array<{
    range: { start: Position; end: Position };
    newText: string;
  }>;
  const byOffset = edits
    .map((e) => ({
      start: doc.offsetAt(e.range.start),
      end: doc.offsetAt(e.range.end),
      newText: e.newText,
    }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of byOffset) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

/** The range of the first LSP diagnostic with the given code. */
function rangeFor(text: string, code: string): Range {
  const a = analyze(URI, text);
  const d = a.lspDiagnostics.find((x) => x.code === code);
  if (!d)
    throw new Error(`no diagnostic ${code}; got ${a.lspDiagnostics.map((x) => x.code).join(",")}`);
  return d.range;
}

describe("vean-lsp code actions — each repair clears its diagnostic on re-analysis", () => {
  it("in-out-beyond-source → clamps the entry out-point; re-analysis is clean", () => {
    const a = analyze(URI, BEYOND_SOURCE);
    expect(a.lspDiagnostics.map((d) => d.code)).toContain("in-out-beyond-source");
    const actions = codeActions(a, rangeFor(BEYOND_SOURCE, "in-out-beyond-source"));
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0]?.title).toMatch(/Trim out-point to 99/);
    const after = analyze(URI, applyAction(BEYOND_SOURCE, actions[0] as never));
    expect(after.lspDiagnostics).toEqual([]); // the pushed set clears entirely
    expect(after.state).toBeDefined(); // still parses + serializes
  });

  it("transition-inverted-window → swaps in/out; re-analysis is clean", () => {
    const doc = twoTrackTransition(20, 10); // in > out
    const a = analyze(URI, doc);
    expect(a.lspDiagnostics.map((d) => d.code)).toContain("transition-inverted-window");
    const actions = codeActions(a, rangeFor(doc, "transition-inverted-window"));
    expect(actions[0]?.title).toMatch(/Swap the transition window to \[10, 20\]/);
    const after = analyze(URI, applyAction(doc, actions[0] as never));
    expect(after.lspDiagnostics.some((d) => d.code === "transition-inverted-window")).toBe(false);
    expect(after.state).toBeDefined();
  });

  it("transition-no-overlap → clamps the window onto content; re-analysis clears it", () => {
    const doc = twoTrackTransition(40, 60); // window past the 25-frame content (ends at 24)
    const a = analyze(URI, doc);
    expect(a.lspDiagnostics.map((d) => d.code)).toContain("transition-no-overlap");
    const actions = codeActions(a, rangeFor(doc, "transition-no-overlap"));
    expect(actions[0]?.title).toMatch(/window \[24, 24\]/);
    const after = analyze(URI, applyAction(doc, actions[0] as never));
    expect(after.lspDiagnostics.some((d) => d.code === "transition-no-overlap")).toBe(false);
    expect(after.state).toBeDefined();
  });

  it("collapses duplicate repairs to ONE action (no-overlap fires per-track but the edit is identical)", () => {
    // The rule fires twice (a_track + b_track both miss the content), but both
    // repairs are the SAME byte edit — the agent must see one quick-fix, not two.
    const doc = twoTrackTransition(40, 60);
    const a = analyze(URI, doc);
    expect(a.veanDiagnostics.filter((d) => d.code === "transition-no-overlap").length).toBe(2);
    const actions = codeActions(a, rangeFor(doc, "transition-no-overlap"));
    expect(actions).toHaveLength(1);
  });

  it("offers NO action for a diagnostic with no deterministic repair (a perceptual warning)", () => {
    // A keyframe animation entirely past the played window — a warning with a
    // non-deterministic fix (re-base or drop). It must yield no code action.
    const doc = `${HEAD}
  <producer id="p0" in="0" out="49">
    <property name="length">50</property><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="shotcut:uuid">c0</property>
    <filter mlt_service="brightness"><property name="level">100=0;200=1</property></filter>
  </producer>
  <playlist id="playlist0"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><property name="shotcut:name">V1</property>
    <entry producer="p0" in="0" out="49"/></playlist>
  <tractor id="tractor0" shotcut="1" title="ca"><track producer="playlist0"/></tractor>
</mlt>`;
    const a = analyze(URI, doc);
    expect(a.lspDiagnostics.map((d) => d.code)).toContain("keyframe-outside-clip");
    // Request actions over the whole document range — none should be offered.
    const whole: Range = { start: Position.create(0, 0), end: Position.create(1000, 0) };
    const actions = codeActions(a, whole);
    expect(actions).toHaveLength(0);
  });

  it("a clean document offers no code actions", () => {
    const clean = twoTrackTransition(0, 19); // a valid in-content window
    const a = analyze(URI, clean);
    expect(a.lspDiagnostics).toEqual([]);
    const whole: Range = { start: Position.create(0, 0), end: Position.create(1000, 0) };
    expect(codeActions(a, whole)).toHaveLength(0);
  });
});

// ─── The full loop over the REAL protocol ────────────────────────────────────
/** Wire the REAL server over a pair of in-memory duplex streams + a client that
 *  records every `publishDiagnostics`. The actual JSON-RPC, not a hand-call. */
type Pushed = { uri: string; diagnostics: Array<{ code?: string | number }> };
function harness(): { client: Connection; pushed: Pushed[]; dispose: () => void } {
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

function settle(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Apply a code action's WorkspaceEdit and return the new full document text. */
function applyWorkspaceEdit(text: string, action: CodeAction): string {
  return applyAction(text, action as unknown as { edit?: { changes?: Record<string, unknown> } });
}

describe("vean-lsp code action OVER THE WIRE — request → apply → re-publish clears", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("a textDocument/codeAction request returns the fix; applying it as a didChange RE-PUBLISHES an empty set", async () => {
    const h = harness();
    dispose = h.dispose;
    await h.client.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} });

    // Open a doc with a real transition defect (inverted window) — the ambient loop
    // pushes the diagnostic.
    const doc = twoTrackTransition(20, 10);
    h.client.sendNotification("textDocument/didOpen", {
      textDocument: { uri: URI, languageId: "mlt", version: 1, text: doc },
    });
    await settle();
    const opened = h.pushed.at(-1);
    expect(opened?.diagnostics.map((d) => d.code)).toContain("transition-inverted-window");

    // Ask the server (real request) for code actions over the diagnostic's range.
    const range = rangeFor(doc, "transition-inverted-window");
    const actions = (await h.client.sendRequest("textDocument/codeAction", {
      textDocument: { uri: URI },
      range,
      context: { diagnostics: [] },
    })) as CodeAction[];
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0]?.title).toMatch(/Swap the transition window/);

    // Apply the fix's edit and send it back as a normal document change — the SAME
    // ambient loop now re-publishes the (cleared) set. No diagnose call anywhere.
    const fixed = applyWorkspaceEdit(doc, actions[0] as CodeAction);
    h.client.sendNotification("textDocument/didChange", {
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: fixed }],
    });
    await settle();
    const last = h.pushed.at(-1);
    expect(last?.uri).toBe(URI);
    expect(last?.diagnostics).toEqual([]); // the repaired defect cleared, re-published
  });
});
