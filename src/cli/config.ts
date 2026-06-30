// `vean config` — discover and tune settings from the CLI (the primitive: every
// tunable behavior is a registered setting, surfaced here so it's findable without
// reading source and changeable without editing code). Backed by the project-local
// `.vean/vean.db`; the registry (`src/state/settings.ts`) is the source of truth, so
// adding a setting there makes it appear in `config list`/`describe` automatically.
//
// A separate module (not inlined in cli.ts) so the surface grows without churning
// the big command file: cli.ts wires it with one `program.addCommand(...)`.
import { resolve } from "node:path";
import { Command } from "commander";
import { type SettingDetail, settingDef } from "../state/settings";
import {
  getSettingDetail,
  listSettings,
  setSetting,
  unsetSetting,
} from "../state/settingsStore";

const repoOf = (opts: { repo?: string }): string => resolve(opts.repo ?? process.cwd());

/** The machine-readable shape for one setting (the `--json` payload). */
function detailJson(d: SettingDetail) {
  return {
    key: d.def.key,
    value: d.value,
    default: d.def.default,
    isDefault: d.isDefault,
    type: d.def.type,
    ...(d.def.allowed ? { allowed: d.def.allowed } : {}),
    ...(d.def.min != null ? { min: d.def.min } : {}),
    ...(d.def.max != null ? { max: d.def.max } : {}),
    description: d.def.description,
  };
}

export function buildConfigCommand(): Command {
  const config = new Command("config").description(
    "Discover and tune vean settings (stored in the project's .vean/vean.db)",
  );

  config
    .command("list")
    .description("List every setting with its current value (a '*' marks an override)")
    .option("--repo <path>", "project repo path")
    .option("--json", "emit JSON")
    .action((opts: { repo?: string; json?: boolean }) => {
      const list = listSettings(repoOf(opts));
      if (opts.json) {
        console.log(JSON.stringify({ settings: list.map(detailJson) }, null, 2));
        return;
      }
      for (const d of list) {
        console.log(`${d.def.key} = ${d.value}${d.isDefault ? "" : " *"}`);
        console.log(`    ${d.def.description}`);
      }
    });

  config
    .command("get <key>")
    .description("Print a setting's effective value")
    .option("--repo <path>", "project repo path")
    .option("--json", "emit JSON")
    .action((key: string, opts: { repo?: string; json?: boolean }) => {
      const d = getSettingDetail(repoOf(opts), key); // throws on unknown key
      console.log(opts.json ? JSON.stringify(detailJson(d), null, 2) : String(d.value));
    });

  config
    .command("set <key> <value>")
    .description("Set a setting (validated against its type / allowed values)")
    .option("--repo <path>", "project repo path")
    .option("--json", "emit JSON")
    .action((key: string, value: string, opts: { repo?: string; json?: boolean }) => {
      const d = setSetting(repoOf(opts), key, value); // validates + persists, throws on bad input
      console.log(opts.json ? JSON.stringify(detailJson(d), null, 2) : `${d.def.key} = ${d.value}`);
    });

  config
    .command("describe <key>")
    .description("Show a setting's type, default, allowed values, and what it controls")
    .option("--json", "emit JSON")
    .action((key: string, opts: { json?: boolean }) => {
      const def = settingDef(key);
      if (!def) throw new Error(`unknown setting: ${key}`);
      if (opts.json) {
        console.log(JSON.stringify(def, null, 2));
        return;
      }
      console.log(`${def.key} (${def.type})`);
      console.log(`  default: ${def.default}`);
      if (def.allowed) console.log(`  allowed: ${def.allowed.join(", ")}`);
      if (def.min != null || def.max != null) {
        console.log(`  range: [${def.min ?? "−∞"}, ${def.max ?? "∞"}]`);
      }
      console.log(`  ${def.description}`);
    });

  config
    .command("unset <key>")
    .description("Clear a setting's override, reverting to the default")
    .option("--repo <path>", "project repo path")
    .option("--json", "emit JSON")
    .action((key: string, opts: { repo?: string; json?: boolean }) => {
      const d = unsetSetting(repoOf(opts), key);
      console.log(
        opts.json ? JSON.stringify(detailJson(d), null, 2) : `${d.def.key} = ${d.value} (default)`,
      );
    });

  return config;
}
