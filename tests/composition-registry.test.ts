// P0 (live-comp-preview) — unit test for the DYNAMIC composition registry's
// resolution logic (`viewer/src/remotion/resolve.ts`). The glob itself
// (`import.meta.glob`) is a Vite transform proven by the viewer build + the
// `verify:live-comp` drive gate; here we pin the PURE module → {component, defaults}
// mapping that turns a globbed comp file into a registry entry — both the
// going-forward `export default` + `export const defaults` convention AND the legacy
// named-export shape (so `LowerThird` resolves with no edit).
import { describe, expect, it } from "vitest";
import {
  idFromPath,
  legacyDefaultsName,
  pickComposition,
  sceneDirFromPath,
  sceneTakeIdFromPath,
  takesFromSceneModule,
} from "../viewer/src/remotion/resolve";

const Comp = () => null; // a stand-in React component (a function is enough)

describe("composition registry resolution", () => {
  it("derives the composition id from the file path (filename, no dir/ext)", () => {
    expect(idFromPath("/abs/remotion/src/compositions/LowerThird.tsx")).toBe("LowerThird");
    expect(idFromPath("../remotion/src/compositions/Title.tsx")).toBe("Title");
    expect(idFromPath("Foo.jsx")).toBe("Foo");
    expect(idFromPath("C:\\proj\\compositions\\Bar.tsx")).toBe("Bar");
  });

  it("maps an id to its legacy `<camelCaseId>Defaults` export name", () => {
    expect(legacyDefaultsName("LowerThird")).toBe("lowerThirdDefaults");
    expect(legacyDefaultsName("Title")).toBe("titleDefaults");
  });

  it("resolves the going-forward convention: default export + `defaults` export", () => {
    const mod = { default: Comp, defaults: { title: "hi" } };
    const picked = pickComposition("Title", mod);
    expect(picked).not.toBeNull();
    expect(picked?.component).toBe(Comp);
    expect(picked?.defaults).toEqual({ title: "hi" });
  });

  it("resolves the legacy shape: a named export matching the id + `<camelId>Defaults`", () => {
    const mod = { LowerThird: Comp, lowerThirdDefaults: { title: "vean" } };
    const picked = pickComposition("LowerThird", mod);
    expect(picked?.component).toBe(Comp);
    expect(picked?.defaults).toEqual({ title: "vean" });
  });

  it("prefers the default export over a same-name named export", () => {
    const other = () => null;
    const picked = pickComposition("Title", { default: Comp, Title: other });
    expect(picked?.component).toBe(Comp);
  });

  it("defaults to `{}` when the module exposes no defaults", () => {
    const picked = pickComposition("Title", { default: Comp });
    expect(picked?.defaults).toEqual({});
  });

  it("returns null for a helper module that exposes no component for the id", () => {
    expect(pickComposition("Theme", { FONT_STACK: "system-ui", theme: {} })).toBeNull();
    expect(pickComposition("Empty", {})).toBeNull();
  });

  it("rejects a plain-object default export (config, not a React component)", () => {
    // `export default { fps: 30, … }` or a helper `.tsx` — no React `$$typeof` marker.
    expect(pickComposition("Config", { default: { fps: 30, some: "config" } })).toBeNull();
    expect(pickComposition("Arr", { default: [1, 2, 3] })).toBeNull();
  });

  it("accepts an object component (memo/forwardRef), not only a function", () => {
    const memoish = { $$typeof: Symbol.for("react.memo"), type: Comp };
    const picked = pickComposition("Fancy", { default: memoish });
    expect(picked?.component).toBe(memoish);
  });

  it("derives the scene-take id from a nested `<Scene>/<Take>.tsx` path", () => {
    expect(sceneTakeIdFromPath("/p/remotion/src/compositions/S03ChatbotFail/B.tsx")).toBe(
      "S03ChatbotFail-B",
    );
    expect(sceneTakeIdFromPath("@project-comp/S08TaxCenter/A.tsx")).toBe("S08TaxCenter-A");
    expect(sceneTakeIdFromPath("C:\\p\\compositions\\S01Intro\\P.tsx")).toBe("S01Intro-P");
  });

  it("resolves the takes shape: `<Scene><Take>` named export for a `<Scene>-<Take>` id", () => {
    // B.tsx: `export const S03ChatbotFailB = …`
    const picked = pickComposition("S03ChatbotFail-B", { S03ChatbotFailB: Comp });
    expect(picked?.component).toBe(Comp);
  });

  it("resolves the placeholder take: `<Scene>` named export for `<Scene>-P`", () => {
    // P.tsx: `export const S03ChatbotFail = …`
    const picked = pickComposition("S03ChatbotFail-P", { S03ChatbotFail: Comp });
    expect(picked?.component).toBe(Comp);
  });

  it("reads the authoritative VARIANTS registry from a scene index module", () => {
    // index.ts: `export const VARIANTS = [{ id, label, component }, …]` — the array
    // the producer's Root.tsx registers takes from. Export-name-agnostic (covers
    // S07CreditsOffer's S07TakeA/S07TakeB shape).
    const takeA = () => null;
    expect(
      takesFromSceneModule({
        VARIANTS: [
          { id: "P", label: "placeholder", component: Comp },
          { id: "A", label: "spotlight", component: takeA },
          { id: "bogus", label: "no component" },
          { id: 7, component: Comp },
        ],
      }),
    ).toEqual([
      { id: "P", component: Comp },
      { id: "A", component: takeA },
    ]);
    expect(takesFromSceneModule({})).toEqual([]);
    expect(takesFromSceneModule({ VARIANTS: "nope" })).toEqual([]);
  });

  it("derives the scene dir from a nested index-module path", () => {
    expect(sceneDirFromPath("@project-comp/S07CreditsOffer/index.ts")).toBe("S07CreditsOffer");
    expect(sceneDirFromPath("/p/compositions/S01Intro/index.ts")).toBe("S01Intro");
  });
});
