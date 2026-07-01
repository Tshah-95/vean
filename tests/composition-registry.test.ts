// P0 (live-comp-preview) — unit test for the DYNAMIC composition registry's
// resolution logic (`viewer/src/remotion/resolve.ts`). The glob itself
// (`import.meta.glob`) is a Vite transform proven by the viewer build + the
// `verify:live-comp` drive gate; here we pin the PURE module → {component, defaults}
// mapping that turns a globbed comp file into a registry entry — both the
// going-forward `export default` + `export const defaults` convention AND the legacy
// named-export shape (so `LowerThird` resolves with no edit).
import { describe, expect, it } from "vitest";
import { idFromPath, legacyDefaultsName, pickComposition } from "../viewer/src/remotion/resolve";

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
});
