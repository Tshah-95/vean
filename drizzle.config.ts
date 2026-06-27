import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/state/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: ".vean/vean.db",
  },
});
