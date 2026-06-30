#!/usr/bin/env bun
// bundle-sidecars.ts — collect a self-contained, relocatable, ad-hoc-signed
// `melt` + `ffmpeg` + `ffprobe` tree for the signed Mac app to ship as Tauri
// SIDECARS, so the .app renders on a clean Mac that has no Homebrew mlt/ffmpeg.
//
// This is the ONLY place vean assembles GPL/LGPL binaries, and it does so for
// the .app artifact ONLY — the source/CLI/Homebrew path keeps treating
// melt/ffmpeg/ffprobe as system deps (Hard boundary #2 in AGENTS.md). vean never
// LINKS any of this: melt is driven arm's-length as a subprocess over the .mlt
// file format + CLI (see LICENSING.md). These binaries are merely *bundled* and
// communicated with over a process boundary.
//
// The pipeline (each step proven by a real scrubbed-env render on macOS arm64):
//   1. locate system melt/ffmpeg/ffprobe + brew prefixes; compute TARGET_TRIPLE.
//   2. compute the MINIMAL headless dylib closure — only the modules a headless
//      render needs (core/avformat/xml/plus/…); EXCLUDE the GUI/vision modules
//      (qt6, opencv, decklink, frei0r, gdk, openfx) that drag in Qt+abseil+opencv
//      (177MB → ~43MB). Handle the install-name-basename-vs-symlink-name gotcha
//      and iterate until zero /opt/homebrew references remain anywhere.
//   3. copy into app/src-tauri/sidecars/ as bin/<name>-<triple>, lib/*.dylib,
//      lib/mlt/*.so, share/mlt/ (whole data tree: profiles + presets + metaschema).
//   4. relocate with install_name_tool (-id / -change / -add_rpath) then ad-hoc
//      re-sign EVERYTHING (mandatory — install_name_tool invalidates signatures,
//      and macOS silently refuses to load an invalid-signature Mach-O).
//   5. write sidecars/MANIFEST.json (versions, sources, SPDX, ffmpeg configure
//      line, written-offer-for-source) and copy license texts to sidecars/licenses/.
//   6. --verify: render a clip in a scrubbed `env -i` environment with MLT_*
//      pointed inside the tree, then ffprobe-assert h264 + dimensions + frames.
//
// Usage:
//   bun run scripts/bundle-sidecars.ts            # build, then verify
//   bun run scripts/bundle-sidecars.ts --verify   # verify an already-built tree
//   bun run scripts/bundle-sidecars.ts --clean     # remove the output tree
//   bun run scripts/bundle-sidecars.ts --no-verify # build only, skip the render
//
// Output dir (app/src-tauri/sidecars/{bin,lib,share,licenses}) is a BUILD
// ARTIFACT — gitignore it.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// ───────────────────────────── config ──────────────────────────────────────

// Headless module allowlist: the MLT modules (`lib/mlt/libmlt<NAME>.so`) a
// headless render needs. EXCLUDES qt6 (Qt6+abseil), opencv (OpenCV+openexr+tbb),
// decklink (capture HW), frei0r/gdk/openfx (GUI/plugin host) — none required to
// render a timeline to a file, and together they ~4× the bundle.
const ESSENTIAL_MODULES = [
  "core", // producers/filters/transitions/consumers core
  "avformat", // the ffmpeg producer + avformat consumer (the renderer)
  "xml", // reads/writes .mlt (mlt_xml producer/consumer)
  "plus", // extra filters/transitions (LGPL set)
  "plusgpl", // extra filters (GPL set)
  "resample", // audio resampling
  "normalize", // audio normalize
  "sdl2", // sdl2 consumer (audio preview path; small)
  "rtaudio", // realtime audio consumer
  "sox", // sox audio filters
  "vorbis", // ogg/vorbis
  "rubberband", // pitch/tempo
  "vidstab", // video stabilize
  "oldfilm", // film-look filters
  "kdenlive", // kdenlive-compat filters/transitions (used by many docs)
  "xine", // deinterlace
] as const;

// Modules deliberately NOT bundled (documented so the exclusion is auditable).
const EXCLUDED_MODULES = ["qt6", "opencv", "decklink", "frei0r", "gdk", "openfx"] as const;

const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));
const OUT_DIR = join(REPO_ROOT, "app", "src-tauri", "sidecars");
const BIN_DIR = join(OUT_DIR, "bin");
const LIB_DIR = join(OUT_DIR, "lib");
const MOD_DIR = join(LIB_DIR, "mlt");
const SHARE_DIR = join(OUT_DIR, "share");
const LICENSES_DIR = join(OUT_DIR, "licenses");

// ───────────────────────────── tiny utils ──────────────────────────────────

const flags = new Set(process.argv.slice(2));
const log = (m: string) => console.log(m);
const step = (m: string) => console.log(`\n\x1b[1m▶ ${m}\x1b[0m`);
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
function die(m: string): never {
  console.error(`\n\x1b[31m✗ ${m}\x1b[0m`);
  process.exit(1);
}

/** Run a command, capture stdout; throw on nonzero unless `allowFail`. */
function sh(cmd: string, args: string[], allowFail = false): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) {
    if (allowFail) return "";
    die(`failed to spawn ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    die(`${cmd} ${args.join(" ")} exited ${r.status}\n${r.stderr ?? ""}`);
  }
  return (r.stdout ?? "").trim();
}

/** `which`, returning null if not found (graceful failure for missing deps). */
function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** `otool -L <file>` → the install-name strings of its direct dependencies
 *  (drops the first line, which is the file itself). */
function otoolDeps(file: string): string[] {
  const out = sh("otool", ["-L", file], true);
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((s): s is string => s.length > 0);
}

function installNameTool(args: string[]): void {
  // install_name_tool is noisy/strict; allow benign "no LC_RPATH" type failures.
  spawnSync("install_name_tool", args, { encoding: "utf8" });
}

function codesignAdhoc(file: string): void {
  const r = spawnSync("codesign", ["--force", "--sign", "-", "--timestamp=none", file], {
    encoding: "utf8",
  });
  if (r.status !== 0) die(`codesign (ad-hoc) failed for ${file}\n${r.stderr ?? ""}`);
}

function codesignValid(file: string): boolean {
  return spawnSync("codesign", ["-v", file], { encoding: "utf8" }).status === 0;
}

const isSystemLib = (p: string) => p.startsWith("/usr/lib/") || p.startsWith("/System/");
const isHomebrew = (p: string) => p.startsWith("/opt/homebrew/") || p.startsWith("/usr/local/");

// ───────────────────────────── step 1: locate ──────────────────────────────

interface Tools {
  melt: string;
  ffmpeg: string;
  ffprobe: string;
  mltPrefix: string;
  ffmpegPrefix: string;
  triple: string;
}

function locate(): Tools {
  step("Locating system melt / ffmpeg / ffprobe");
  const meltLink = which("melt");
  const ffmpegLink = which("ffmpeg");
  const ffprobeLink = which("ffprobe");
  if (!meltLink) die("`melt` not found on PATH. Install MLT: `brew install mlt`.");
  if (!ffmpegLink) die("`ffmpeg` not found on PATH. Install: `brew install ffmpeg`.");
  if (!ffprobeLink) die("`ffprobe` not found on PATH. Install: `brew install ffmpeg`.");

  const melt = realpathSync(meltLink);
  const ffmpeg = realpathSync(ffmpegLink);
  const ffprobe = realpathSync(ffprobeLink);

  const mltPrefix = sh("brew", ["--prefix", "mlt"], true) || dirname(dirname(melt));
  const ffmpegPrefix = sh("brew", ["--prefix", "ffmpeg"], true) || dirname(dirname(ffmpeg));
  if (!existsSync(join(mltPrefix, "lib", "mlt"))) {
    die(
      `MLT module dir not found at ${join(mltPrefix, "lib", "mlt")} — is mlt installed via brew?`,
    );
  }

  const rustcV = sh("rustc", ["-vV"], true);
  const triple =
    rustcV
      .split("\n")
      .find((l) => l.startsWith("host:"))
      ?.split(/\s+/)[1] ?? "";
  if (!triple) die("could not read target triple from `rustc -vV` (is Rust installed?)");

  ok(`melt    ${melt}`);
  ok(`ffmpeg  ${ffmpeg}`);
  ok(`ffprobe ${ffprobe}`);
  ok(`mlt prefix    ${mltPrefix}`);
  ok(`ffmpeg prefix ${ffmpegPrefix}`);
  ok(`target triple ${triple}`);
  return { melt, ffmpeg, ffprobe, mltPrefix, ffmpegPrefix, triple };
}

// ───────────────────── step 2 + 3: closure + copy ──────────────────────────

/** Resolve an install-name token to an absolute source path we can copy from.
 *  @rpath/<x> in the MLT tree means <mltPrefix>/lib/<x> (libmlt's rpath). */
function resolveDep(dep: string, mltPrefix: string): string | null {
  if (dep.startsWith("@rpath/")) return join(mltPrefix, "lib", dep.slice("@rpath/".length));
  if (dep.startsWith("@loader_path/") || dep.startsWith("@executable_path/")) return null;
  if (isSystemLib(dep)) return null;
  return dep; // already an absolute /opt/homebrew path
}

/** BFS the transitive non-system dylib closure of a set of seed Mach-O files.
 *  Returns a map keyed by the INSTALL-NAME basename (the symlink-versioned name
 *  that dependents reference, e.g. `libavcodec.62.dylib`) → the real source file
 *  to copy. Keying by install-name basename is the fix for the
 *  symlink-name-vs-real-file gotcha: a dependent says `libavcodec.62.dylib`, but
 *  `realpath` gives `libavcodec.62.28.102.dylib`; we must copy under the former. */
function computeClosure(seeds: string[], mltPrefix: string): Map<string, string> {
  const byInstallName = new Map<string, string>(); // installNameBase → real source path
  const seenReal = new Set<string>();
  const queue = [...seeds];

  while (queue.length) {
    const cur = queue.shift();
    if (!cur) continue;
    let real: string;
    try {
      real = realpathSync(cur);
    } catch {
      continue;
    }
    if (seenReal.has(real)) continue;
    seenReal.add(real);

    for (const dep of otoolDeps(real)) {
      const src = resolveDep(dep, mltPrefix);
      if (!src) continue;
      let realSrc: string;
      try {
        realSrc = realpathSync(src);
      } catch {
        continue;
      }
      // The name dependents will reference == basename of the install-name token.
      // For @rpath/foo.dylib that's foo.dylib; for an absolute path it's its base.
      const installBase = basename(dep);
      if (!byInstallName.has(installBase)) byInstallName.set(installBase, realSrc);
      if (!seenReal.has(realSrc)) queue.push(realSrc);
    }
  }
  return byInstallName;
}

function copyAndDeref(src: string, dst: string): void {
  // Copy the real file content (deref symlinks) and make it writable for
  // install_name_tool + codesign.
  cpSync(realpathSync(src), dst, { dereference: true });
  spawnSync("chmod", ["u+w", dst]);
}

function du(path: string): string {
  return sh("du", ["-sh", path], true).split(/\s+/)[0] || "?";
}

interface Built {
  binFiles: string[]; // absolute paths in BIN_DIR (with -triple suffix)
  libFiles: string[]; // absolute *.dylib in LIB_DIR
  modFiles: string[]; // absolute *.so in MOD_DIR
  modulesBundled: string[];
  modulesSkipped: string[];
}

function build(t: Tools): Built {
  step("Computing minimal headless dylib closure");
  const moduleSrcDir = join(t.mltPrefix, "lib", "mlt");
  const available = readdirSync(moduleSrcDir).filter((f) => f.endsWith(".so"));
  const modulesBundled: string[] = [];
  const modulesSkipped: string[] = [];
  const moduleSeeds: string[] = [];
  for (const name of ESSENTIAL_MODULES) {
    const f = `libmlt${name}.so`;
    if (available.includes(f)) {
      moduleSeeds.push(join(moduleSrcDir, f));
      modulesBundled.push(name);
    } else {
      warn(`essential module libmlt${name}.so not present in this MLT build — skipping`);
    }
  }
  for (const f of available) {
    const name = f.replace(/^libmlt/, "").replace(/\.so$/, "");
    if (!modulesBundled.includes(name)) modulesSkipped.push(name);
  }

  const seeds = [t.melt, t.ffmpeg, t.ffprobe, ...moduleSeeds];
  const closure = computeClosure(seeds, t.mltPrefix);
  ok(`${closure.size} dylibs in closure (modules bundled: ${modulesBundled.length})`);
  ok(`excluded modules: ${modulesSkipped.join(", ") || "none"}`);

  step("Copying binaries, modules, dylibs, and data tree");
  for (const d of [BIN_DIR, MOD_DIR, SHARE_DIR]) mkdirSync(d, { recursive: true });

  // binaries → bin/<name>-<triple>
  const binFiles: string[] = [];
  for (const [name, src] of [
    ["melt", t.melt],
    ["ffmpeg", t.ffmpeg],
    ["ffprobe", t.ffprobe],
  ] as const) {
    const dst = join(BIN_DIR, `${name}-${t.triple}`);
    copyAndDeref(src, dst);
    binFiles.push(dst);
  }
  ok(`3 binaries → bin/<name>-${t.triple}`);

  // modules → lib/mlt/*.so (keep original .so names)
  const modFiles: string[] = [];
  for (const s of moduleSeeds) {
    const dst = join(MOD_DIR, basename(s));
    copyAndDeref(s, dst);
    modFiles.push(dst);
  }
  ok(`${modFiles.length} modules → lib/mlt/*.so`);

  // dylibs → lib/<install-name-base>  (flat)
  const libFiles: string[] = [];
  for (const [installBase, src] of closure) {
    const dst = join(LIB_DIR, installBase);
    if (!existsSync(dst)) {
      copyAndDeref(src, dst);
      libFiles.push(dst);
    }
  }
  ok(`${libFiles.length} dylibs → lib/*.dylib`);

  // data tree → share/mlt (profiles + presets + per-module metaschema)
  const shareSrc = join(t.mltPrefix, "share", "mlt");
  if (!existsSync(shareSrc)) die(`MLT data dir not found at ${shareSrc}`);
  cpSync(shareSrc, join(SHARE_DIR, "mlt"), { recursive: true });
  spawnSync("chmod", ["-R", "u+w", join(SHARE_DIR, "mlt")]);
  const nProfiles = readdirSync(join(SHARE_DIR, "mlt", "profiles")).length;
  ok(`share/mlt (${nProfiles} profiles, ${du(join(SHARE_DIR, "mlt"))})`);

  return { binFiles, libFiles, modFiles, modulesBundled, modulesSkipped };
}

// ───────────────────── step 4: relocate + re-sign ──────────────────────────

/** Rewrite one file's homebrew/@rpath deps to @rpath/<installBase> when we have
 *  that lib in LIB_DIR. Returns true if any homebrew ref still remains after. */
function rewriteDeps(file: string, haveLib: Set<string>): void {
  for (const dep of otoolDeps(file)) {
    if (dep.startsWith("@rpath/") || isHomebrew(dep)) {
      const base = basename(dep);
      if (haveLib.has(base)) installNameTool(["-change", dep, `@rpath/${base}`, file]);
    }
  }
}

function relocate(b: Built, t: Tools): void {
  step("Relocating load paths to @rpath / @loader_path");
  const haveLib = new Set(readdirSync(LIB_DIR).filter((f) => f.endsWith(".dylib")));

  // 1. dylibs: set id, rewrite deps, add self rpath (@loader_path == lib/).
  for (const f of readdirSync(LIB_DIR).map((n) => join(LIB_DIR, n))) {
    if (!f.endsWith(".dylib")) continue;
    installNameTool(["-id", `@rpath/${basename(f)}`, f]);
    rewriteDeps(f, haveLib);
    installNameTool(["-add_rpath", "@loader_path", f]);
  }
  // 2. .so modules: rewrite deps, rpath up one level (@loader_path/.. == lib/).
  for (const f of b.modFiles) {
    rewriteDeps(f, haveLib);
    installNameTool(["-add_rpath", "@loader_path/..", f]);
  }
  // 3. binaries: rewrite deps, then add BOTH rpath layouts so the bins resolve
  //    their dylibs in the dev tree AND the packaged .app:
  //      • `@loader_path/../lib` — the dev tree, where bin/ and lib/ are siblings.
  //      • `@loader_path/../Resources/sidecars/lib` — the packaged .app, where Tauri
  //        puts the bins in `Contents/MacOS` and the dylibs in
  //        `Contents/Resources/sidecars/lib`, so the sibling-relative ../lib misses
  //        (points at the non-existent `Contents/lib`). Without this, the packaged
  //        `ffprobe` crashes on launch (dyld: libavdevice not loaded) — which makes
  //        `sourceHasAlpha` silently degrade every alpha overlay to an opaque proxy.
  //        Baking the rpath fixes it WITHOUT relying on DYLD_FALLBACK_LIBRARY_PATH
  //        (which renderer_env also sets, as a belt-and-suspenders backstop).
  for (const f of b.binFiles) {
    rewriteDeps(f, haveLib);
    installNameTool(["-add_rpath", "@loader_path/../lib", f]);
    installNameTool(["-add_rpath", "@loader_path/../Resources/sidecars/lib", f]);
  }
  ok("install_name_tool rewrite complete");

  // 4. Iterate: a freshly-rewritten lib can still reference a homebrew dep whose
  //    install-name basename we already have — sweep until zero remain.
  let pass = 0;
  for (;;) {
    pass++;
    let remaining = 0;
    const all = [
      ...readdirSync(LIB_DIR)
        .filter((n) => n.endsWith(".dylib"))
        .map((n) => join(LIB_DIR, n)),
      ...b.modFiles,
      ...b.binFiles,
    ];
    for (const f of all) {
      for (const dep of otoolDeps(f)) {
        if (isHomebrew(dep)) {
          const base = basename(dep);
          if (haveLib.has(base)) installNameTool(["-change", dep, `@rpath/${base}`, f]);
          else remaining++;
        }
      }
    }
    if (remaining === 0 || pass > 8) {
      if (remaining > 0) {
        warn(
          `${remaining} homebrew refs point at libs not in the closure (likely fine if optional)`,
        );
      }
      break;
    }
  }

  // 5. ASSERT: zero homebrew references anywhere.
  const all = [
    ...readdirSync(LIB_DIR)
      .filter((n) => n.endsWith(".dylib"))
      .map((n) => join(LIB_DIR, n)),
    ...b.modFiles,
    ...b.binFiles,
  ];
  const leftovers: string[] = [];
  for (const f of all) {
    for (const dep of otoolDeps(f)) {
      if (isHomebrew(dep)) leftovers.push(`${basename(f)} → ${dep}`);
    }
  }
  if (leftovers.length) {
    die(
      `relocation incomplete — ${leftovers.length} homebrew refs remain:\n  ${leftovers.slice(0, 20).join("\n  ")}`,
    );
  }
  ok("zero /opt/homebrew or /usr/local references remain (asserted)");

  // 6. MANDATORY re-sign — install_name_tool invalidated every signature, and
  //    macOS silently refuses to load an invalid-signature Mach-O.
  step("Ad-hoc re-signing (mandatory after install_name_tool)");
  for (const f of all) codesignAdhoc(f);
  // Assert the melt binary now verifies.
  const melt = b.binFiles.find((f) => basename(f).startsWith("melt-"));
  if (!melt || !codesignValid(melt)) die("ad-hoc signature did not validate on melt — aborting");
  ok(`re-signed ${all.length} Mach-O files; melt signature validates`);
}

// ─────────────────── step 5: manifest + license texts ──────────────────────

/** Parse the `configuration:` line out of `ffmpeg -version`. */
function ffmpegConfigure(ffmpeg: string): string {
  const out = sh(ffmpeg, ["-version"], true);
  const line = out.split("\n").find((l) => l.startsWith("configuration:")) ?? "";
  return line.replace(/^configuration:\s*/, "").trim();
}

function versionOf(bin: string, kind: "melt" | "ffmpeg"): string {
  if (kind === "melt") {
    const out = sh(bin, ["--version"], true);
    return out.split("\n")[0]?.replace(/^melt\s+/, "") ?? "unknown";
  }
  const out = sh(bin, ["-version"], true);
  const m = out.match(/ffmpeg version (\S+)/);
  return m?.[1] ?? "unknown";
}

function ffmpegIsGpl(configure: string): { gpl: boolean; version3: boolean } {
  return {
    gpl: configure.includes("--enable-gpl"),
    version3: configure.includes("--enable-version3"),
  };
}

function writeManifest(t: Tools, b: Built): void {
  step("Writing provenance manifest + license texts");
  const meltVer = versionOf(t.melt, "melt");
  const ffVer = versionOf(t.ffmpeg, "ffmpeg");
  const configure = ffmpegConfigure(t.ffmpeg);
  const { gpl, version3 } = ffmpegIsGpl(configure);
  const ffmpegLicense = gpl
    ? version3
      ? "GPL-3.0-or-later"
      : "GPL-2.0-or-later"
    : "LGPL-2.1-or-later";

  // Best-effort brew metadata for exact provenance (revision + tap).
  const brewInfo = (pkg: string) => {
    const j = sh("brew", ["info", "--json=v2", pkg], true);
    try {
      const parsed = JSON.parse(j);
      const f = parsed.formulae?.[0];
      return { version: f?.versions?.stable ?? "unknown", tap: f?.tap ?? "homebrew/core" };
    } catch {
      return { version: "unknown", tap: "homebrew/core" };
    }
  };
  const mltBrew = brewInfo("mlt");
  const ffBrew = brewInfo("ffmpeg");

  const manifest = {
    schema: "vean.sidecars/1",
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/bundle-sidecars.ts",
    note:
      "Bundled GPL/LGPL subprocess sidecars for the signed Mac app ONLY. vean " +
      "drives these arm's-length over the .mlt file format + CLI; it never links " +
      "libmlt or libavcodec (see LICENSING.md, AGENTS.md Hard boundary #1/#2). The " +
      "source/CLI/Homebrew distribution uses system mlt/ffmpeg and bundles nothing.",
    platform: { triple: t.triple, builtOn: process.platform, arch: process.arch },
    components: [
      {
        name: "melt",
        role: "MLT command-line renderer (subprocess)",
        version: meltVer,
        source: "https://github.com/mltframework/mlt",
        upstream: "https://www.mltframework.org/",
        homebrew: { formula: "mlt", version: mltBrew.version, tap: mltBrew.tap },
        spdx: "GPL-2.0-or-later",
        notes: "libmlt itself is LGPL-2.1; the `melt` binary + libmltplusgpl are GPL-2.0.",
      },
      {
        name: "ffmpeg",
        role: "encoder/muxer (subprocess; also linked by libmltavformat)",
        version: ffVer,
        source: "https://github.com/FFmpeg/FFmpeg",
        upstream: "https://ffmpeg.org/",
        homebrew: { formula: "ffmpeg", version: ffBrew.version, tap: ffBrew.tap },
        spdx: ffmpegLicense,
        configure,
        notes:
          `Built ${gpl ? "with --enable-gpl" : "LGPL-only"}${version3 ? " --enable-version3" : ""}` +
          `${gpl ? ` — includes GPL components (x264/x265). Effective license: ${ffmpegLicense}.` : "."}`,
      },
      {
        name: "ffprobe",
        role: "media inspector (subprocess)",
        version: ffVer,
        source: "https://github.com/FFmpeg/FFmpeg",
        spdx: ffmpegLicense,
        configure,
      },
    ],
    bundledModules: b.modulesBundled,
    excludedModules: b.modulesSkipped,
    dylibCount: readdirSync(LIB_DIR).filter((f) => f.endsWith(".dylib")).length,
    writtenOfferForSource: {
      statement:
        "The complete corresponding source for every GPL/LGPL component bundled " +
        "here is available at the upstream repositories listed per component, at " +
        "the exact versions recorded above. On request, vean will provide the " +
        "corresponding source for the versions distributed in this build for a " +
        "period of three years, per GPL section 3(b).",
      mlt: `https://github.com/mltframework/mlt (tag matching ${meltVer})`,
      ffmpeg: `https://github.com/FFmpeg/FFmpeg (tag matching n${ffVer})`,
      x264: "https://code.videolan.org/videolan/x264",
      x265: "https://bitbucket.org/multicoreware/x265_git",
    },
  };

  mkdirSync(LICENSES_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  ok("MANIFEST.json written");

  // Copy any license texts homebrew shipped for mlt/ffmpeg; otherwise drop a
  // pointer README so the licenses/ dir is never silently empty.
  let copied = 0;
  for (const [pkg, prefix] of [
    ["mlt", t.mltPrefix],
    ["ffmpeg", t.ffmpegPrefix],
  ] as const) {
    for (const cand of [
      "COPYING",
      "COPYING.txt",
      "LICENSE",
      "LICENSE.txt",
      "COPYING.GPLv2",
      "COPYING.LGPLv2.1",
    ]) {
      const src = join(prefix, "share", "doc", pkg, cand);
      if (existsSync(src)) {
        cpSync(src, join(LICENSES_DIR, `${pkg}-${cand}`));
        copied++;
      }
    }
  }
  writeFileSync(
    join(LICENSES_DIR, "README.md"),
    [
      "# Bundled component licenses",
      "",
      "Full license texts for the GPL/LGPL subprocess sidecars vean's Mac app bundles.",
      "vean never links these (arm's-length subprocess only — see LICENSING.md).",
      "",
      "- MLT framework (`libmlt`): LGPL-2.1 · `melt` + GPL modules: GPL-2.0 — https://github.com/mltframework/mlt",
      "- FFmpeg: GPL/LGPL depending on build config (see MANIFEST.json `configure`) — https://github.com/FFmpeg/FFmpeg",
      "- x264: GPL-2.0 · x265: GPL-2.0 — bundled via FFmpeg's `--enable-gpl`",
      "",
      "See ../MANIFEST.json for exact versions, the ffmpeg configure line, SPDX ids,",
      "and the written offer for corresponding source (GPL §3(b)).",
      "",
    ].join("\n"),
  );
  ok(`license texts: ${copied} upstream file(s) copied + README pointer`);
}

// ───────────────────────────── step 6: verify ──────────────────────────────

function verify(triple: string): void {
  step("Verifying — scrubbed-env render (no Homebrew on PATH/DYLD)");
  const melt = join(BIN_DIR, `melt-${triple}`);
  const ffprobe = join(BIN_DIR, `ffprobe-${triple}`);
  if (!existsSync(melt) || !existsSync(ffprobe)) {
    die(`built sidecars not found in ${BIN_DIR} — run without --verify first to build`);
  }

  const out = join(OUT_DIR, ".verify.mp4");
  try {
    rmSync(out, { force: true });
  } catch {}

  // env -i: a clean environment with NO /opt/homebrew anywhere — simulates a
  // clean Mac with no `brew install mlt`. MLT_* point inside the bundled tree.
  const scrubbed = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? "/tmp",
    MLT_REPOSITORY: MOD_DIR,
    MLT_DATA: join(SHARE_DIR, "mlt"),
    MLT_PROFILES_PATH: join(SHARE_DIR, "mlt", "profiles"),
    MLT_PRESETS_PATH: join(SHARE_DIR, "mlt", "presets"),
  };
  const r = spawnSync(
    melt,
    [
      "-profile",
      "atsc_1080p_30",
      "color:blue",
      "out=14",
      "-consumer",
      `avformat:${out}`,
      "vcodec=libx264",
    ],
    { encoding: "utf8", env: scrubbed }, // NOTE: env replaces, doesn't extend → fully scrubbed
  );
  if (r.status !== 0) {
    die(
      `scrubbed render FAILED (exit ${r.status}):\n${(r.stderr ?? "").split("\n").slice(-15).join("\n")}`,
    );
  }
  if (!existsSync(out) || statSync(out).size === 0) die("render produced no output file");
  ok(`melt rendered a clip in a scrubbed env (${statSync(out).size} bytes)`);

  // ffprobe (also bundled + relocated) must confirm a real h264 stream.
  const probe = spawnSync(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,nb_frames",
      "-of",
      "default=noprint_wrappers=1",
      out,
    ],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: scrubbed.HOME } },
  );
  if (probe.status !== 0) die(`bundled ffprobe failed:\n${probe.stderr ?? ""}`);
  const fields = Object.fromEntries(
    probe.stdout
      .trim()
      .split("\n")
      .map((l) => l.split("=")),
  );
  if (fields.codec_name !== "h264") die(`expected h264, got ${fields.codec_name}`);
  if (fields.width !== "1920" || fields.height !== "1080") {
    die(`expected 1920x1080, got ${fields.width}x${fields.height}`);
  }
  if (Number(fields.nb_frames) !== 15) die(`expected 15 frames, got ${fields.nb_frames}`);
  ok(`bundled ffprobe confirms h264 ${fields.width}x${fields.height} ${fields.nb_frames} frames`);
  try {
    rmSync(out, { force: true });
  } catch {}
}

// ───────────────────────────── main ────────────────────────────────────────

function clean(): void {
  step("Cleaning sidecars build artifact");
  for (const d of [BIN_DIR, LIB_DIR, SHARE_DIR, LICENSES_DIR]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  const m = join(OUT_DIR, "MANIFEST.json");
  if (existsSync(m)) rmSync(m, { force: true });
  ok("removed bin/ lib/ share/ licenses/ MANIFEST.json (kept README.md)");
}

function main(): void {
  if (process.platform !== "darwin") {
    die("bundle-sidecars currently supports macOS only (install_name_tool/codesign).");
  }
  const t0 = Date.now();
  log("\x1b[1mvean · bundle-sidecars\x1b[0m — self-contained melt/ffmpeg/ffprobe for the Mac app");

  if (flags.has("--clean")) {
    clean();
    return;
  }

  if (flags.has("--verify") && !flags.has("--build")) {
    // verify-only: need the triple but not a system melt necessarily.
    const triple =
      sh("rustc", ["-vV"], true)
        .split("\n")
        .find((l) => l.startsWith("host:"))
        ?.split(/\s+/)[1] ?? "";
    if (!triple) die("could not determine target triple for --verify");
    verify(triple);
    ok(`\x1b[32mVERIFY PASSED\x1b[0m in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // Full build.
  const tools = locate();
  if (existsSync(BIN_DIR)) clean(); // idempotent: start from a clean tree
  const built = build(tools);
  relocate(built, tools);
  writeManifest(tools, built);

  step("Build summary");
  ok(`output: ${OUT_DIR}`);
  ok(`total size: ${du(OUT_DIR)}`);
  ok(
    `binaries: 3 (melt, ffmpeg, ffprobe) · modules: ${built.modFiles.length} · dylibs: ${built.libFiles.length}`,
  );

  if (!flags.has("--no-verify")) verify(tools.triple);
  ok(`\x1b[32mDONE\x1b[0m in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
