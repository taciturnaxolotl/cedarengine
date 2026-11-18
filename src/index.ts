/**
 * The server.
 *
 * Bun's router does the dispatching and lib/pipeline.ts wraps every handler
 * with authentication, roles, masks and the audit log. This file only wires
 * them together and refuses to start without a way in.
 */

import { serve } from "bun";
import { version } from "../package.json";
import account from "./account.html";
import admin from "./admin.html";
import { trimAudit } from "./auth/audit";
import { tokenCount } from "./auth/tokens";
import { config } from "./config";
import dashboard from "./dashboard.html";
import { trim } from "./lib/analytics";
import { errorResponse, json } from "./lib/http";
import { openapi } from "./lib/openapi";
import { pipeline } from "./lib/pipeline";
import map from "./map.html";
import { routes } from "./routes";

if (!config.bearerToken && !config.indikoUrl && tokenCount() === 0) {
  throw new Error(
    "no way to authenticate: set BEARER_TOKEN or INDIKO_URL, or mint a token with `bun run engine token create`",
  );
}

const table: Record<string, Record<string, ReturnType<typeof pipeline>>> = {};
for (const route of routes) {
  table[route.path] ??= {};
  table[route.path]![route.method] = pipeline(route);
}

const spec = openapi(routes, version);

const server = serve({
  port: config.port,
  hostname: config.hostname,
  development: false,
  routes: {
    ...table,
    "/": dashboard,
    "/map": map,
    "/admin": admin,
    "/account": account,
    "/openapi.json": () => json(spec),
  },
  fetch: () => json({ error: "not found" }, 404),
  error: (error) => errorResponse(error),
});

// Analytics are for shape, not for keeping. Thirty days of rows is plenty and
// the trim costs nothing, so it happens at boot rather than on a schedule.
const trimmed = trim();
const trimmedAudit = trimAudit();

console.log(`cedarengine ${version} on http://${server.hostname}:${server.port}`);
console.log(`  ${routes.length} routes  ·  ${config.databasePath}`);
if (trimmed) console.log(`  trimmed ${trimmed} old request rows`);
if (trimmedAudit)
  console.log(`  trimmed ${trimmedAudit} audit rows past ${config.auditRetentionDays} days`);
console.log(
  `  sign-in: ${config.indikoUrl ? `indiko (${config.indikoUrl}) for ${config.publicUrl}` : "indiko off"}`,
);
if (config.hostname !== "127.0.0.1" && config.hostname !== "localhost") {
  console.log("  listening beyond loopback — authentication is the only thing in the way");
}
