#!/usr/bin/env bun
import { TextDocument } from "vscode-languageserver-textdocument";
// vean-lsp — the stdio Language Server binding.
//
// This is the TRANSPORT layer only. All knowledge lives in the transport-free LSP
// modules (each of which calls the SHARED core — src/diagnostics, src/query,
// src/ir/source-map): `./engine` produces the `analyze` result, `./navigation`
// answers hover/references/definition, `./codeActions` builds the deterministic
// repairs. This file just wires the JSON-RPC connection to those pure functions:
//
//   • a document store keyed by URI (`TextDocuments`), syncing full document text
//     on open/change/close (standard LSP `textDocument/didOpen|didChange`);
//   • on every open/change → `analyze(uri, text)` → `connection.sendDiagnostics`
//     with the FULL current set (an empty set clears prior diagnostics). THIS is
//     the ambient loop: the agent's editor receives `publishDiagnostics` after a
//     change with no separate `diagnose` call — and because a code action's
//     WorkspaceEdit is itself a document change, applying a fix re-runs this loop
//     and RE-PUBLISHES the (now-cleared) diagnostic set with no extra step;
//   • navigation (hover / references / definition) delegated to `./navigation`,
//     code actions to `./codeActions`.
//
// Run it over stdio: `bun src/bridge/lsp/server.ts` (wired as the `vean-lsp` bin
// in package.json). A Claude Code / VS Code client launches it and speaks LSP.
//
// PROTOCOL FIDELITY (BUILD-MONITOR review lens #5): this uses the real LSP —
// document sync + `publishDiagnostics` (push) + references/definition/hover +
// code actions. There is NO bespoke polling protocol; an editor that speaks LSP
// gets ambient vean diagnostics for free.
import {
  type CodeActionParams,
  type Connection,
  type DefinitionParams,
  type HoverParams,
  type InitializeResult,
  type ReferenceParams,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} from "vscode-languageserver/node";
import { codeActions } from "./codeActions";
import { analyze } from "./engine";
import { definition, hover, references } from "./navigation";

/** Wire all vean-lsp handlers onto a connection + document store. Exposed (rather
 *  than inlined into `main`) so a test could drive it against a paired in-memory
 *  connection; the ambient smoke test drives the engine directly (cheaper), but
 *  this keeps the wiring itself testable + reusable. */
export function registerHandlers(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
): void {
  connection.onInitialize(
    (): InitializeResult => ({
      capabilities: {
        // FULL document sync: vean re-parses the whole `.mlt` per change (the
        // documents are small, and the source map + IR are computed from the
        // whole text), so full sync is both correct and simplest.
        textDocumentSync: TextDocumentSyncKind.Full,
        hoverProvider: true,
        referencesProvider: true,
        definitionProvider: true,
        codeActionProvider: true,
      },
      serverInfo: { name: "vean-lsp", version: "0.1.0" },
    }),
  );

  // ── The ambient loop: publish diagnostics on every open + change ──────────
  // `onDidChangeContent` fires for BOTH didOpen and didChange (the TextDocuments
  // manager normalizes them), so one handler covers both. We analyze and push the
  // full current set; an empty array clears. No `diagnose` verb in this path.
  documents.onDidChangeContent((change) => {
    publish(connection, change.document);
  });

  // On close, clear the document's diagnostics (LSP convention: a closed document
  // shows no diagnostics).
  documents.onDidClose((event) => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  // ── Navigation + code actions (delegated to the engine) ───────────────────
  connection.onHover((params: HoverParams) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    return hover(analyze(doc.uri, doc.getText()), params.position);
  });

  connection.onReferences((params: ReferenceParams) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return references(analyze(doc.uri, doc.getText()), params.position);
  });

  connection.onDefinition((params: DefinitionParams) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    return definition(analyze(doc.uri, doc.getText()), params.position);
  });

  connection.onCodeAction((params: CodeActionParams) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return codeActions(analyze(doc.uri, doc.getText()), params.range);
  });
}

/** Analyze a document and push its full diagnostic set. The single ambient-publish
 *  primitive; `onDidChangeContent` calls it. */
function publish(connection: Connection, doc: TextDocument): void {
  const analysis = analyze(doc.uri, doc.getText());
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: analysis.lspDiagnostics });
}

/** Boot the stdio server. Called when this module is the entrypoint. */
export function main(): void {
  const connection = createConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  );
  const documents = new TextDocuments(TextDocument);
  registerHandlers(connection, documents);
  documents.listen(connection);
  connection.listen();
}

if (import.meta.main) main();
