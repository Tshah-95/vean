export type BrowserMutationObservation = {
  currentDocumentUri: string;
  expectedActionId: string;
  expectedInput: Record<string, unknown>;
  actionRequest: { op?: string; args?: Record<string, unknown>; route?: string };
  actionResponse: {
    ok?: boolean;
    consequences?: Record<string, unknown>;
    diagnostics?: unknown[];
    health?: { errors?: number; warnings?: number };
    dirty?: boolean;
  };
  saveResponse: { ok?: boolean; path?: string };
  beforeMltHash: string;
  afterMltHash: string;
  parsedPlacement: { track: string; position: number; uuid: string } | null;
  expectedPlacement: { track: string; position: number; uuid: string };
  dom: {
    clipName?: string;
    dirtyBeforeSave?: boolean;
    dirtyAfterSave?: boolean;
    selectionPolicy?: {
      bodyUserSelect: string;
      bodyWebkitUserSelect: string;
      chromeUserSelect: string;
      chromeWebkitUserSelect: string;
      inputUserSelect: string;
      inputWebkitUserSelect: string;
      inputSelectionStart: number | null;
      inputSelectionEnd: number | null;
      inputValueLength: number;
      clipDragRequestCount: number;
      clipDragText: string;
      clipDragRangeCount: number;
      duringText: string;
      duringRangeCount: number;
      duringCollapsed: boolean;
      afterText: string;
      afterRangeCount: number;
      afterCollapsed: boolean;
    };
  };
  cleanup: { developerCanaryUnchanged: boolean; sourceCorpusUnchanged: boolean };
};

export type BrowserTruthIssue = {
  code:
    | "E_BROWSER_ACTION"
    | "E_BROWSER_ACTION_INPUT"
    | "E_BROWSER_ACTION_ENVELOPE"
    | "E_BROWSER_DIAGNOSTICS"
    | "E_BROWSER_DOM"
    | "E_BROWSER_DOCUMENT_PERSISTENCE"
    | "E_BROWSER_CURRENT_URI"
    | "E_BROWSER_PARSED_IR"
    | "E_BROWSER_CLEANUP";
  detail: string;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evaluateBrowserMutation(observation: BrowserMutationObservation): {
  ok: boolean;
  issues: BrowserTruthIssue[];
} {
  const issues: BrowserTruthIssue[] = [];
  if (observation.actionRequest.op !== observation.expectedActionId) {
    issues.push({
      code: "E_BROWSER_ACTION",
      detail: `${String(observation.actionRequest.op)} != ${observation.expectedActionId}`,
    });
  }
  if (stable(observation.actionRequest.args ?? {}) !== stable(observation.expectedInput)) {
    issues.push({ code: "E_BROWSER_ACTION_INPUT", detail: "validated action input mismatched" });
  }
  if (
    observation.actionResponse.ok !== true ||
    observation.actionResponse.dirty !== true ||
    !observation.actionResponse.consequences
  ) {
    issues.push({
      code: "E_BROWSER_ACTION_ENVELOPE",
      detail: "apply-op did not return a successful dirty consequence envelope",
    });
  }
  if (
    !Array.isArray(observation.actionResponse.diagnostics) ||
    observation.actionResponse.diagnostics.length !== 0 ||
    observation.actionResponse.health?.errors !== 0
  ) {
    issues.push({
      code: "E_BROWSER_DIAGNOSTICS",
      detail: "expected the complete post-action diagnostic set to contain zero errors",
    });
  }
  if (
    observation.dom.dirtyBeforeSave !== true ||
    observation.dom.dirtyAfterSave !== false ||
    !observation.dom.clipName?.includes(
      `timeline frames ${observation.expectedPlacement.position} to`,
    )
  ) {
    issues.push({
      code: "E_BROWSER_DOM",
      detail: "visible editor state did not reflect the authoritative action/save lifecycle",
    });
  }
  const selection = observation.dom.selectionPolicy;
  if (
    selection?.bodyUserSelect !== "none" ||
    selection.bodyWebkitUserSelect !== "none" ||
    selection.chromeUserSelect !== "none" ||
    selection.chromeWebkitUserSelect !== "none" ||
    selection.inputUserSelect !== "text" ||
    selection.inputWebkitUserSelect !== "text" ||
    selection.inputSelectionStart !== 0 ||
    selection.inputSelectionEnd !== selection.inputValueLength ||
    selection.inputValueLength <= 0 ||
    selection.clipDragRequestCount !== 1 ||
    selection.clipDragText !== "" ||
    selection.clipDragRangeCount !== 0 ||
    selection.duringText !== "" ||
    selection.duringRangeCount !== 0 ||
    selection.duringCollapsed !== true ||
    selection.afterText !== "" ||
    selection.afterRangeCount !== 0 ||
    selection.afterCollapsed !== true
  ) {
    issues.push({
      code: "E_BROWSER_DOM",
      detail: "desktop selection/input policy or physical drag submission regressed",
    });
  }
  if (
    observation.saveResponse.ok !== true ||
    observation.beforeMltHash === observation.afterMltHash
  ) {
    issues.push({
      code: "E_BROWSER_DOCUMENT_PERSISTENCE",
      detail: "visible state changed without changing the persisted current .mlt",
    });
  }
  if (
    observation.actionRequest.route !== observation.currentDocumentUri ||
    observation.saveResponse.path !== observation.currentDocumentUri
  ) {
    issues.push({
      code: "E_BROWSER_CURRENT_URI",
      detail: `action/save touched ${String(observation.actionRequest.route)}/${String(
        observation.saveResponse.path,
      )}, expected ${observation.currentDocumentUri}`,
    });
  }
  if (stable(observation.parsedPlacement) !== stable(observation.expectedPlacement)) {
    issues.push({
      code: "E_BROWSER_PARSED_IR",
      detail: "independently reparsed .mlt placement mismatched the expected edit",
    });
  }
  if (!observation.cleanup.developerCanaryUnchanged || !observation.cleanup.sourceCorpusUnchanged) {
    issues.push({
      code: "E_BROWSER_CLEANUP",
      detail: "fixture escaped into developer/source state",
    });
  }
  return { ok: issues.length === 0, issues };
}
