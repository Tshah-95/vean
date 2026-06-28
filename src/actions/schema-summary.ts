import { z } from "zod";

export type SchemaSummary = {
  type: string;
  required?: string[];
  properties?: Record<string, SchemaSummary>;
  enum?: string[];
  default?: unknown;
  description?: string;
  items?: SchemaSummary;
  union?: SchemaSummary[];
  optional?: boolean;
};

type ZodDef = {
  typeName?: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  out?: z.ZodTypeAny;
  options?: z.ZodTypeAny[] | Map<string, z.ZodTypeAny>;
  values?: Record<string, unknown>;
  value?: unknown;
  shape?: unknown;
  valueType?: z.ZodTypeAny;
  defaultValue?: unknown;
};

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function typeName(schema: z.ZodTypeAny): string {
  return defOf(schema).typeName ?? "unknown";
}

function getShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  const shape = defOf(schema).shape;
  if (typeof shape === "function") return shape() as Record<string, z.ZodTypeAny>;
  return (shape ?? {}) as Record<string, z.ZodTypeAny>;
}

function defaultValue(def: ZodDef): unknown {
  if (typeof def.defaultValue === "function") return def.defaultValue();
  return def.defaultValue;
}

export function summarizeSchema(schema: z.ZodTypeAny): SchemaSummary {
  const def = defOf(schema);
  const name = typeName(schema);

  if (name === "ZodDefault" && def.innerType) {
    return { ...summarizeSchema(def.innerType), default: defaultValue(def) };
  }
  if (name === "ZodOptional" && def.innerType) {
    return { ...summarizeSchema(def.innerType), optional: true };
  }
  if (name === "ZodNullable" && def.innerType) {
    return {
      ...summarizeSchema(def.innerType),
      type: `${summarizeSchema(def.innerType).type}|null`,
    };
  }
  if (name === "ZodEffects" && def.schema) return summarizeSchema(def.schema);
  if (name === "ZodPipeline" && def.out) return summarizeSchema(def.out);

  if (schema instanceof z.ZodObject) {
    const shape = getShape(schema);
    const properties: Record<string, SchemaSummary> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const property = summarizeSchema(value);
      properties[key] = property;
      if (!property.optional && property.default === undefined) required.push(key);
    }
    const summary: SchemaSummary = { type: "object", properties };
    if (required.length > 0) summary.required = required;
    return summary;
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodUnknown) return { type: "unknown" };
  if (schema instanceof z.ZodAny) return { type: "any" };
  if (schema instanceof z.ZodNever) return { type: "never" };
  if (schema instanceof z.ZodLiteral) return { type: "literal", enum: [String(def.value)] };
  if (schema instanceof z.ZodEnum) return { type: "enum", enum: [...schema.options] };
  if (schema instanceof z.ZodNativeEnum) {
    const values = Object.values(def.values ?? {}).filter((value) => typeof value === "string");
    return { type: "enum", enum: values.map(String) };
  }
  if (schema instanceof z.ZodArray)
    return { type: "array", items: summarizeSchema(schema.element) };
  if (schema instanceof z.ZodRecord)
    return { type: "record", items: summarizeSchema(def.valueType ?? z.unknown()) };
  if (schema instanceof z.ZodUnion) {
    const options = Array.isArray(def.options) ? def.options : [];
    return { type: "union", union: options.map((option) => summarizeSchema(option)) };
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = [...schema.options.values()];
    return { type: "union", union: options.map((option) => summarizeSchema(option)) };
  }

  return { type: "unknown", description: `unsupported zod kind: ${name}` };
}
