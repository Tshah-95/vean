import { z } from "zod";

export const RUNTIME_LAYOUT_SCHEMA_VERSION = "vean.runtime-layout/1" as const;
export const RUNTIME_MANIFEST_SCHEMA_VERSION = "vean.runtime-manifest/1" as const;

export const runtimeModeSchema = z.enum(["development", "package"]);
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

export const resourceClassSchema = z.enum([
  "core",
  "viewer",
  "migration",
  "skill",
  "renderer-executable",
  "renderer-library",
  "renderer-data",
  "node",
  "remotion",
  "browser",
  "composition",
  "compliance",
]);
export type ResourceClass = z.infer<typeof resourceClassSchema>;

export const runtimeResourceSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9._-]*$/),
    class: resourceClassSchema,
    relative_path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().min(0).max(0o777),
    executable: z.boolean(),
    requirement: z.enum(["startup-required", "operation-lazy", "distribution-only"]),
  })
  .strict();
export type RuntimeResource = z.infer<typeof runtimeResourceSchema>;

export const runtimeLayoutSchema = z
  .object({
    schema_version: z.literal(RUNTIME_LAYOUT_SCHEMA_VERSION),
    mode: runtimeModeSchema,
    package_root: z.string().min(1),
    project_root: z.string().min(1),
    development_checkout_root: z.string().min(1).nullable(),
    manifest_relative_path: z.literal("runtime-manifest.json"),
    resources: z.array(runtimeResourceSchema),
  })
  .strict()
  .superRefine((layout, ctx) => {
    if (layout.mode === "package" && layout.development_checkout_root !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["development_checkout_root"],
        message: "package mode cannot name a development checkout",
      });
    }
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const [index, resource] of layout.resources.entries()) {
      if (ids.has(resource.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resources", index, "id"],
          message: "duplicate resource id",
        });
      }
      if (paths.has(resource.relative_path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resources", index, "relative_path"],
          message: "duplicate resource path",
        });
      }
      ids.add(resource.id);
      paths.add(resource.relative_path);
    }
  });
export type RuntimeLayout = z.infer<typeof runtimeLayoutSchema>;
