/**
 * The spec, generated from the route table.
 *
 * Not a full OpenAPI document — no response schemas, because writing them by
 * hand would put the same drift back that generating this removed. What it
 * does carry is every path, method, parameter and summary, which is what
 * someone reaching for the API actually needs.
 */

import type { RouteDef } from "../routes/types";

const pathParams = (path: string) =>
  [...path.matchAll(/:(\w+)/g)].map((match) => ({
    name: match[1]!,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));

export function openapi(routes: RouteDef[], version: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const path = route.path.replace(/:(\w+)/g, "{$1}");
    paths[path] ??= {};
    paths[path]![route.method.toLowerCase()] = {
      summary: route.summary,
      tags: [route.tag],
      security: route.open ? [] : [{ bearer: [] }],
      ...(route.open ? {} : { "x-capability": route.access ?? "admin" }),
      parameters: [
        ...pathParams(route.path),
        ...(route.query ?? []).map((param) => ({
          name: param.name,
          in: "query",
          required: param.required ?? false,
          description: param.description,
          schema: { type: "string" },
        })),
      ],
      ...(route.body
        ? {
            requestBody: {
              content: {
                "application/json": { schema: { type: "object" }, example: route.body },
              },
            },
          }
        : {}),
      responses: {
        "200": { description: "ok" },
        ...(route.open
          ? {}
          : {
              "401": { description: "missing, expired or unknown token" },
              "403": { description: "the token's role lacks this capability, or a mask hides it" },
            }),
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "cedarengine",
      version,
      description:
        "One API over the Cedarville directory, course catalog, printed book, harvested booklists and the campus map.",
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearer: [] }],
    paths,
  };
}
