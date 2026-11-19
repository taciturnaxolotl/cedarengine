/**
 * What happens to every request, in order.
 *
 * Authenticate, check the route's capability against the caller's role,
 * apply the role's masks before and after the handler, swap in decoys for a
 * canary, then write the analytics row and the audit row. Route handlers see
 * none of this; they only ever receive requests they are allowed to answer.
 */

import type { Server } from "bun";
import { audit } from "../auth/audit";
import { decoyResponse } from "../auth/decoy";
import { greyballLevelFor, greyballResponse, obscurePayload } from "../auth/greyball";
import { forbiddenFilter, policyFor, stripFields } from "../auth/masks";
import { authenticate, type Principal, presentedToken } from "../auth/principal";
import { can } from "../auth/roles";
import { config } from "../config";
import type { RouteDef, RouteRequest } from "../routes/types";
import { anyGreyball, greyballLevels } from "../store/greyball";
import { record } from "./analytics";
import { errorResponse, forbidden, unauthorized } from "./http";

type Handler = (request: Request, server?: Server<unknown>) => Promise<Response>;

function clientIp(request: Request, server?: Server<unknown>): string | null {
  if (config.trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return server?.requestIP(request)?.address ?? null;
}

async function answer(
  route: RouteDef,
  request: RouteRequest,
  principal: Principal,
): Promise<Response> {
  const url = new URL(request.url);
  const policy = policyFor(principal.role);
  if (policy.routes.has(route.path)) throw forbidden("hidden for your role");
  const filter = forbiddenFilter(policy, url);
  if (filter) throw forbidden(`filtering by ${filter} is hidden for your role`);

  request.principal = principal;
  // A greyballed caller sees invented answers: the whole directory at level 2,
  // exactly like a canary, or only the timetables at level 1. One lookup says
  // whether the feature is in play at all; when it is not, the answer below
  // passes through untouched the way it always did.
  const greyballed = !principal.canary && route.access === "people" && anyGreyball();
  const level = greyballed ? greyballLevelFor(principal, greyballLevels()) : null;
  const invented = (principal.canary || level === 2) && route.access === "people";
  const response =
    (invented ? decoyResponse(route.path, url, request.params ?? {}) : null) ??
    (level === 1 ? greyballResponse(route.path, url, request.params ?? {}) : null) ??
    (await route.handler(request, url));

  const isJson = response.headers.get("content-type")?.startsWith("application/json");
  if (!isJson) return response;
  if (level !== 1 && policy.fields.size === 0) return response;
  const body = obscurePayload(route.path, await response.json(), level);
  const masked = policy.fields.size === 0 ? body : stripFields(body, policy.fields);
  return new Response(JSON.stringify(masked), {
    status: response.status,
    headers: response.headers,
  });
}

export function pipeline(route: RouteDef): Handler {
  return async (request, server) => {
    const started = performance.now();
    let principal: Principal | null = null;
    let status = 200;
    try {
      let response: Response;
      if (route.open) {
        response = await route.handler(request as RouteRequest, new URL(request.url));
      } else {
        const who = await authenticate(presentedToken(request, !!route.queryAuth));
        if (typeof who === "string") throw unauthorized(who);
        principal = who;
        if (!can(principal.role, route.access ?? "admin")) throw forbidden();
        response = await answer(route, request as RouteRequest, principal);
      }
      status = response.status;
      return response;
    } catch (error) {
      const response = errorResponse(error);
      status = response.status;
      return response;
    } finally {
      record(route.path, status, Math.round((performance.now() - started) * 100) / 100);
      if (principal) {
        const url = new URL(request.url);
        audit({
          principal,
          method: request.method,
          endpoint: route.path,
          path: `${url.pathname}${url.search}`.replace(/([?&]token=)[^&]*/, "$1[redacted]"),
          status,
          ip: clientIp(request, server),
          userAgent: request.headers.get("user-agent"),
        });
      }
    }
  };
}
