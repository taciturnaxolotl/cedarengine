/**
 * A route is a handler plus enough description to document itself.
 *
 * The alternative is a hand-written OpenAPI file, which is a second source of
 * truth that starts drifting the day after it is written. Here the spec is
 * generated from the same array the server dispatches on, so a route that
 * exists is a route that is documented.
 */

import type { Principal } from "../auth/principal";
import type { Capability } from "../auth/roles";

export interface RouteRequest extends Request {
  params: Record<string, string>;
  /** Who is asking. Absent only on open routes. */
  principal?: Principal;
}

export interface Param {
  name: string;
  description: string;
  required?: boolean;
}

export interface RouteDef {
  method: "GET" | "POST";
  path: string;
  summary: string;
  tag: string;
  /** Query-string parameters. Path parameters are read off the path itself. */
  query?: Param[];
  body?: string;
  /** Skips the bearer check. Only /health and the OAuth metadata do. */
  open?: boolean;
  /** The capability a caller's role must include. Unset fails closed, as admin. */
  access?: Capability;
  /**
   * Also accept the token from a `?token=` query parameter, for the one case a
   * browser loads a URL with no chance to set a header: an `<img>` src.
   */
  queryAuth?: boolean;
  handler: (request: RouteRequest, url: URL) => Response | Promise<Response>;
}
