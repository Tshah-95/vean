// The STRICT XML-VALIDITY invariant — the durable guard for the class of bug where
// a `.mlt` opens in `melt` (namespace-LENIENT) but Shotcut REFUSES it with
//   "Namespace prefix shotcut for filter on filter is not defined"
// because Shotcut parses with a namespace-AWARE QXmlStreamReader. The root cause
// was the serializer emitting `shotcut:filter` / `shotcut:transition` as NAMESPACED
// XML ATTRIBUTES without declaring the `shotcut:` namespace. Genuine Shotcut stores
// these as `<property>` CHILDREN (plain strings) — which is what the serializer now
// does — so NO element may ever carry a namespaced (`prefix:`) attribute again.
//
// Two layers, so a regression is caught with or without a system binary:
//   1. A HERMETIC structural scan (always runs, no subprocess): parse every
//      `toMlt()` output and assert no element has an attribute whose name carries a
//      `:` prefix. That is exactly "no undeclared-prefix attribute can escape".
//   2. The AUTHORITATIVE `xmllint --noout --nsclean` (namespace-aware) on the same
//      output — the real oracle Shotcut's reader mirrors — run when xmllint exists.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { VEAN_FIXTURES } from "../corpus/vean-fixtures";
import { toMlt } from "../src/ir/serialize";

// ─── Layer 1: hermetic structural namespace scan ─────────────────────────────
/** Every XML attribute name carrying a `prefix:` in the document. An empty array
 *  means no namespaced attribute exists — the invariant we enforce. We allow
 *  `xmlns`/`xmlns:*` DECLARATIONS (which would legitimately introduce a prefix),
 *  but vean emits none, so any `prefix:attr` here is an undeclared-prefix defect. */
function namespacedAttrs(xml: string): string[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  });
  type Node = Record<string, unknown> & { ":@"?: Record<string, string> };
  const tree = parser.parse(xml) as Node[];
  const hits: string[] = [];
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      const a = node[":@"];
      if (a) {
        for (const key of Object.keys(a)) {
          const name = key.startsWith("@_") ? key.slice(2) : key;
          // A namespaced attribute name contains `:`. `xmlns` / `xmlns:foo` are
          // namespace DECLARATIONS, not the defect, so they're exempt.
          if (name.includes(":") && name !== "xmlns" && !name.startsWith("xmlns:")) {
            hits.push(name);
          }
        }
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === ":@") continue;
        if (Array.isArray(v)) walk(v as Node[]);
      }
    }
  };
  walk(tree);
  return hits;
}

describe("XML namespace validity — no element carries a namespaced attribute", () => {
  for (const [name, make] of Object.entries(VEAN_FIXTURES)) {
    it(`${name}: toMlt() emits zero namespaced (prefix:) XML attributes`, () => {
      expect(namespacedAttrs(toMlt(make()))).toEqual([]);
    });
  }

  it("the Shotcut logical names survive — as <property> children, not dropped", () => {
    // The fix must NOT simply delete the metadata to dodge the namespace error: the
    // multitrack fixture carries shotcut:filter (the fades) AND shotcut:transition
    // (the dissolve), and both must re-appear as namespace-safe <property> children.
    const make = VEAN_FIXTURES["vean-multitrack.mlt"];
    if (!make) throw new Error("expected the vean-multitrack fixture to exist");
    const xml = toMlt(make());
    expect(xml).toContain('<property name="shotcut:filter">fadeInBrightness</property>');
    expect(xml).toContain('<property name="shotcut:transition">lumaMix</property>');
    expect(namespacedAttrs(xml)).toEqual([]);
  });

  it("the scan DOES catch a namespaced attribute (the bug, were it reintroduced)", () => {
    const bad = '<mlt><filter mlt_service="brightness" shotcut:filter="fadeInBrightness"/></mlt>';
    expect(namespacedAttrs(bad)).toEqual(["shotcut:filter"]);
  });
});

// ─── Layer 2: authoritative xmllint (namespace-aware) ────────────────────────
function hasXmllint(): boolean {
  try {
    execFileSync("xmllint", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** xmllint's diagnostics for a file, captured regardless of exit code — a namespace
 *  error is reported on stderr at EXIT 0, so we must read stderr, not the code. */
function xmllintDiagnostics(path: string): string {
  const cmd = `xmllint --noout --nsclean '${path.replace(/'/g, "'\\''")}' 2>&1 || true`;
  return execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim();
}

describe.runIf(hasXmllint())("XML namespace validity — xmllint (namespace-aware oracle)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vean-nsxml-"));
  for (const [name, make] of Object.entries(VEAN_FIXTURES)) {
    it(`${name}: toMlt() output is namespace-clean under xmllint --nsclean`, () => {
      const path = join(dir, name);
      writeFileSync(path, toMlt(make()));
      expect(xmllintDiagnostics(path)).toBe("");
    });
  }
});
