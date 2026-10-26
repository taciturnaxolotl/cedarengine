/**
 * The server.
 *
 * Bun's router does the dispatching, so this file is the three things that
 * wrap every handler: the bearer check, the timer that feeds analytics, and
 * one place where a thrown HttpError becomes a response. Everything else lives
 * in the route modules.
 */

import { serve } from "bun";
import { version } from "../package.json";
import { config } from "./config";
import dashboard from "./dashboard.html";
import { record, trim } from "./lib/analytics";
import { errorResponse, json, unauthorized } from "./lib/http";
import { openapi } from "./lib/openapi";
import map from "./map.html";
import { routes } from "./routes";
import type { RouteDef, RouteRequest } from "./routes/types";

const token = config.bearerToken;

/**
 * Constant-time comparison, because a bearer check that leaks its own answer
 * through timing is decoration. The token rides in the `Authorization` header,
 * or for a route that opts in, a `token` query parameter — the one way an
 * `<img>` the browser loads can carry it.
 */
function authorised(request: Request, route: RouteDef): boolean {
  const header = request.headers.get("authorization") ?? "";
  let given = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!given && route.queryAuth) given = new URL(request.url).searchParams.get("token") ?? "";
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function wrap(route: RouteDef) {
  return async (request: Request): Promise<Response> => {
    const started = performance.now();
    let status = 200;
    try {
      if (!route.open && !authorised(request, route)) throw unauthorized();
      const response = await route.handler(request as RouteRequest, new URL(request.url));
      status = response.status;
      return response;
    } catch (error) {
      const response = errorResponse(error);
      status = response.status;
      return response;
    } finally {
      record(route.path, status, Math.round((performance.now() - started) * 100) / 100);
    }
  };
}

const table: Record<string, Record<string, (request: Request) => Promise<Response>>> = {};
for (const route of routes) {
  table[route.path] ??= {};
  table[route.path]![route.method] = wrap(route);
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
    "/openapi.json": () => json(spec),
  },
  fetch: () => json({ error: "not found" }, 404),
  error: (error) => errorResponse(error),
});

// Analytics are for shape, not for keeping. Thirty days of rows is plenty and
// the trim costs nothing, so it happens at boot rather than on a schedule.
const trimmed = trim();

console.log(`cedarengine ${version} on http://${server.hostname}:${server.port}`);
console.log(`  ${routes.length} routes  ·  ${config.databasePath}`);
if (trimmed) console.log(`  trimmed ${trimmed} old request rows`);
if (config.hostname !== "127.0.0.1" && config.hostname !== "localhost") {
  console.log("  listening beyond loopback — the bearer token is the only thing in the way");
}
