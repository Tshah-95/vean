import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeAction, listActions } from "../src/actions";
import { projectTauriActions } from "../src/actions/tauri-projection";

type Check = {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

type Report = {
  ok: boolean;
  checks: Check[];
};

const root = join(import.meta.dirname, "..");
const appRoot = join(root, "app");

function check(name: string, status: Check["status"], detail: string): Check {
  return { name, status, detail };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function commandExists(command: string): boolean {
  const result = spawnSync("zsh", ["-f", "-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function nativeBuildCheck(): Check {
  const result = spawnSync("bun", ["run", "tauri:build"], {
    cwd: appRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status === 0) {
    return check("native:build", "pass", "Tauri native app build completed");
  }
  return check(
    "native:build",
    "fail",
    (result.stderr || result.stdout || "native build failed")
      .trim()
      .split("\n")
      .slice(-6)
      .join("\n"),
  );
}

function appChecks(options: { native?: boolean } = {}): Check[] {
  const checks: Check[] = [];

  const packagePath = join(appRoot, "package.json");
  if (!existsSync(packagePath)) {
    checks.push(check("app:package", "fail", "app/package.json is missing"));
  } else {
    const pkg = readJson(packagePath) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const hasScripts = pkg.scripts?.dev && pkg.scripts?.build && pkg.scripts?.["tauri:build"];
    checks.push(
      check("app:package", hasScripts ? "pass" : "fail", "app package declares Vite/Tauri scripts"),
    );
    const hasTauri =
      pkg.dependencies?.["@tauri-apps/api"] && pkg.devDependencies?.["@tauri-apps/cli"];
    checks.push(
      check("app:tauri-deps", hasTauri ? "pass" : "fail", "app package declares Tauri deps"),
    );
  }

  const configPath = join(appRoot, "src-tauri", "tauri.conf.json");
  if (!existsSync(configPath)) {
    checks.push(check("tauri:config", "fail", "tauri.conf.json is missing"));
  } else {
    const config = readJson(configPath) as {
      identifier?: string;
      app?: { windows?: Array<{ label?: string }> };
      bundle?: { targets?: string[]; resources?: string[] };
    };
    checks.push(
      check(
        "tauri:config",
        config.identifier === "studio.vean.desktop" &&
          config.app?.windows?.some((window) => window.label === "main")
          ? "pass"
          : "fail",
        "Tauri config declares the vean app id and main window",
      ),
    );
    checks.push(
      check(
        "tauri:bundle",
        config.bundle?.targets?.includes("app") &&
          config.bundle?.resources?.includes("sidecars/README.md")
          ? "pass"
          : "fail",
        "Tauri bundle builds a Mac app and carries sidecar manifest resources",
      ),
    );
  }

  const iconPath = join(appRoot, "src-tauri", "icons", "icon.png");
  checks.push(
    check(
      "tauri:icon",
      existsSync(iconPath) ? "pass" : "fail",
      existsSync(iconPath) ? "RGBA app icon exists" : "src-tauri/icons/icon.png is missing",
    ),
  );

  const capabilityPath = join(appRoot, "src-tauri", "capabilities", "default.json");
  if (!existsSync(capabilityPath)) {
    checks.push(check("tauri:capability", "fail", "default capability is missing"));
  } else {
    const capability = readJson(capabilityPath) as {
      windows?: string[];
      permissions?: string[];
    };
    checks.push(
      check(
        "tauri:capability",
        capability.windows?.includes("main") && capability.permissions?.includes("core:default")
          ? "pass"
          : "fail",
        "default capability binds core permissions to the main window",
      ),
    );
  }

  const cargoPath = join(appRoot, "src-tauri", "Cargo.toml");
  checks.push(
    check(
      "tauri:cargo",
      existsSync(cargoPath) && readFileSync(cargoPath, "utf8").includes("tauri =")
        ? "pass"
        : "fail",
      "Cargo manifest declares Tauri runtime",
    ),
  );

  const descriptors = listActions().map(describeAction);
  const hasTauriProjection = descriptors.some((action) => action.surfaces.cli?.hidden !== true);
  checks.push(
    check(
      "actions:registry",
      hasTauriProjection ? "pass" : "fail",
      `action registry exposes ${descriptors.length} descriptors for app wiring`,
    ),
  );

  // The Tauri projection must cover every registered action (one generic
  // `run_action` command per id) so the app never grows a second runtime.
  const tauriActions = projectTauriActions();
  const fullyProjected =
    tauriActions.length === descriptors.length &&
    tauriActions.every((action) => action.command === "run_action");
  checks.push(
    check(
      "actions:tauri-projection",
      fullyProjected ? "pass" : "fail",
      `action registry projects ${tauriActions.length}/${descriptors.length} actions to the run_action bridge`,
    ),
  );

  checks.push(
    check(
      "native:cargo",
      commandExists("cargo") && commandExists("rustc") ? "pass" : "warn",
      commandExists("cargo") && commandExists("rustc")
        ? "Rust toolchain is available for native Tauri builds"
        : "Rust toolchain is not on PATH; scaffold verification can pass, native Tauri build cannot run here",
    ),
  );

  if (options.native) {
    checks.push(nativeBuildCheck());
  }

  return checks;
}

function format(report: Report): string {
  return report.checks
    .map((item) => `${item.status.toUpperCase().padEnd(5)} ${item.name}: ${item.detail}`)
    .join("\n");
}

const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const native = process.argv.includes("--native");
const checks = appChecks({ native });
const ok =
  checks.every((item) => item.status !== "fail") &&
  (!strict || checks.every((item) => item.status === "pass"));
const report = { ok, checks };

if (json) console.log(JSON.stringify(report, null, 2));
else console.log(format(report));

process.exit(ok ? 0 : 1);
