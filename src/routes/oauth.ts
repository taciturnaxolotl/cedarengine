/**
 * The documents indiko and the apps read to find each other.
 *
 * Each app's client_id is the URL of its metadata document here, so indiko
 * registers it on first use and holds it to exactly these redirect URIs. The
 * protected-resource document (RFC 9728) names this engine on indiko's
 * consent screen and tells the apps where to sign in.
 */

import { config } from "../config";
import { json, notFound } from "../lib/http";
import type { RouteDef } from "./types";

export const CLIENTS = ["web", "tokens", "ios", "extension"] as const;
export type ClientName = (typeof CLIENTS)[number];

export const clientId = (name: ClientName) => `${config.publicUrl}/oauth/${name}.json`;

const NAMES: Record<ClientName, string> = {
  web: "cedarengine",
  tokens: "cedarengine personal tokens",
  ios: "cedarengine for iOS",
  extension: "cedarengine sync",
};

function redirectUris(name: ClientName): string[] {
  if (name === "web" || name === "tokens") return [`${config.publicUrl}/account`];
  if (name === "ios") return ["cedarengine://oauth"];
  return config.extensionIds.map((id) => `https://${id}.chromiumapp.org/`);
}

export const oauthRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    tag: "oauth",
    summary:
      "Protected resource metadata (RFC 9728): this engine's audience and its sign-in server",
    open: true,
    handler: () => {
      if (!config.indikoUrl) throw notFound("indiko sign-in is not configured");
      return json({
        resource: config.publicUrl,
        resource_name: "cedarengine",
        authorization_servers: [config.indikoUrl],
        bearer_methods_supported: ["header"],
        clients: Object.fromEntries(CLIENTS.map((name) => [name, clientId(name)])),
      });
    },
  },
  {
    method: "GET",
    path: "/oauth/:client",
    tag: "oauth",
    summary:
      "Client metadata for one of the engine's own apps: web, tokens, ios or extension (.json)",
    open: true,
    handler: (request) => {
      const name = request.params.client?.replace(/\.json$/, "") as ClientName;
      if (!CLIENTS.includes(name)) throw notFound("no such client");
      return json({
        client_id: clientId(name),
        client_name: NAMES[name],
        client_uri: config.publicUrl,
        redirect_uris: redirectUris(name),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    },
  },
];
