import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Only `drizzle-kit studio` and a manual `db:migrate` need this: the server
  // applies its own migrations on open (src/db/database.ts).
  dbCredentials: { url: process.env.DB_PATH ?? "../../.data/server.sqlite" },
});
