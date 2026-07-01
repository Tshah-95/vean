// The navigation-query barrel (Move 1b). Pure, document-keyed queries over the
// IR — the read side of the LSP surface (the write side is `src/ops`, the validity
// side is `src/diagnostics`). Two queries:
//   • resolveValueAtFrame — "go-to-definition for video": the effective value of a
//     parameter at a frame, resolved through the nested scope chain, with the path.
//   • findReferences      — "find all references": clips using a source, readers/
//     writers of a property, a clip's adjacency/ripple set.
export {
  resolveValueAtFrame,
  type ResolveTarget,
  type ResolveResult,
  type ResolutionHop,
} from "./resolve";
export {
  findReferences,
  type ReferenceQuery,
  type ReferenceResult,
  type ClipSite,
  type PropertySite,
  type RippleSite,
} from "./references";
export {
  summarizeTimeline,
  frameTimecode,
  type TimelineSummary,
  type TrackSummary,
  type ItemSummary,
  type ClipSummary,
  type BlankSummary,
  type DissolveSummary,
  type TransitionSummary,
  type DiagnosticSummary,
} from "./summary";
export { formatTimelineSummary } from "./summary-format";
