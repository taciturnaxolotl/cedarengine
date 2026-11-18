/** Managing who gets in: minted tokens, role masks and the audit log. */

import { auditLog } from "../auth/audit";
import {
  exchangeCode,
  personalTokensEnabled,
  remember,
  revokeAtIndiko,
  seal,
} from "../auth/grants";
import { introspect } from "../auth/indiko";
import {
  allMasks,
  checkCustomMask,
  deleteCustomMask,
  isMask,
  maskableParts,
  masksFor,
  rolesUsing,
  roleWithin,
  saveCustomMask,
  setMasks,
} from "../auth/masks";
import { CAPABILITIES, isRole, ROLES, type Role } from "../auth/roles";
import { createToken, listTokens, revokeToken, sealedRefresh } from "../auth/tokens";
import { config } from "../config";
import { badRequest, body, bool, forbidden, json, notFound, num, q } from "../lib/http";
import type { RouteDef, RouteRequest } from "./types";

const principalOf = (request: RouteRequest) => request.principal!;

const MAX_PERSONAL_DAYS = 90;

/** Personal tokens are for people signed in with indiko, not for other tokens to breed. */
function signedInPerson(request: RouteRequest): { sub: string; role: Role } {
  const me = principalOf(request);
  if (!me.actor.startsWith("indiko:") || !me.owner) {
    throw forbidden("sign in with indiko to manage personal tokens");
  }
  return { sub: me.owner, role: me.role };
}

/** Roles a person may mint for themselves: their own, or any that does and sees less. */
const mintableRoles = (role: Role) =>
  (Object.keys(ROLES) as Role[]).filter((candidate) => roleWithin(candidate, role));

interface MintBody {
  label?: string;
  role?: string;
  expiresInDays?: number;
  code?: string;
  codeVerifier?: string;
}

export const accountRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/v1/me",
    tag: "account",
    summary: "Who this token belongs to, its role, what that role may do and what it cannot see",
    handler: (request) => {
      const me = principalOf(request);
      const personal = personalTokensEnabled() && me.actor.startsWith("indiko:");
      return json({
        name: me.name,
        actor: me.actor,
        role: me.role,
        client: me.client,
        capabilities: ROLES[me.role],
        masks: masksFor(me.role),
        personalTokens: personal
          ? { mintableRoles: mintableRoles(me.role), maxDays: MAX_PERSONAL_DAYS }
          : null,
      });
    },
  },
  {
    method: "GET",
    path: "/v1/me/tokens",
    tag: "account",
    summary: "Your personal tokens. Needs an indiko sign-in",
    handler: (request) => json({ tokens: listTokens(signedInPerson(request).sub) }),
  },
  {
    method: "POST",
    path: "/v1/me/tokens",
    tag: "account",
    summary:
      "Mint a personal token backed by a fresh indiko sign-in through the tokens client. The secret is in this response only",
    body: '{ "label": "my script", "role": "reader", "expiresInDays": 30, "code": "…", "codeVerifier": "…" }',
    handler: async (request) => {
      if (!personalTokensEnabled())
        throw badRequest("personal tokens need INDIKO_URL and SECRET_KEY");
      const me = signedInPerson(request);
      const payload = await body<MintBody>(request);
      const label = payload.label?.trim();
      if (!label || label.length > 120) throw badRequest("label is required, up to 120 characters");
      if (!isRole(payload.role) || !mintableRoles(me.role).includes(payload.role)) {
        throw badRequest(`role must be one of: ${mintableRoles(me.role).join(", ")}`);
      }
      const days = Number(payload.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > MAX_PERSONAL_DAYS) {
        throw badRequest(`expiresInDays must be a whole number from 1 to ${MAX_PERSONAL_DAYS}`);
      }
      if (!payload.code || !payload.codeVerifier)
        throw badRequest("code and codeVerifier are required");

      const clientId = `${config.publicUrl}/oauth/tokens.json`;
      const grant = await exchangeCode(
        clientId,
        payload.code,
        payload.codeVerifier,
        `${config.publicUrl}/account`,
      );
      if (typeof grant === "string") throw badRequest(grant);
      // The sign-in must be the same person, through the tokens client, for this engine.
      const checked = await introspect(grant.access);
      if (!checked || checked.sub !== me.sub || checked.clientId !== clientId) {
        await revokeAtIndiko(seal(grant.refresh));
        throw badRequest("that sign-in was for a different account; sign in as yourself");
      }

      const { token, record } = createToken(label, payload.role, {
        personal: {
          owner: me.sub,
          ownerName: checked.username,
          refreshSealed: seal(grant.refresh),
          expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
        },
      });
      remember(record.id, grant.access, grant.expiresIn);
      return json({ token, record }, 201);
    },
  },
  {
    method: "POST",
    path: "/v1/me/tokens/:id/revoke",
    tag: "account",
    summary: "Revoke one of your personal tokens, here and at indiko",
    handler: async (request) => {
      const me = signedInPerson(request);
      const id = Number(request.params.id);
      const sealed = sealedRefresh(id);
      if (!revokeToken(id, me.sub)) throw notFound("no live token of yours with that id");
      await revokeAtIndiko(sealed);
      return json({ revoked: true });
    },
  },
];

interface TokenBody {
  label?: string;
  role?: string;
  canary?: boolean;
}

export const adminRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/v1/admin/tokens",
    tag: "admin",
    summary: "Every minted token, live and revoked. Never the secrets",
    handler: () => json({ tokens: listTokens() }),
  },
  {
    method: "POST",
    path: "/v1/admin/tokens",
    tag: "admin",
    summary: "Mint a token. The secret is in this response and nowhere else",
    body: '{ "label": "assassins bot", "role": "editor", "canary": false }',
    handler: async (request) => {
      const payload = await body<TokenBody>(request);
      const label = payload.label?.trim();
      if (!label || label.length > 120) throw badRequest("label is required, up to 120 characters");
      if (!isRole(payload.role)) {
        throw badRequest(`role must be one of: ${Object.keys(ROLES).join(", ")}`);
      }
      const { token, record } = createToken(label, payload.role, {
        canary: payload.canary === true,
      });
      return json({ token, record }, 201);
    },
  },
  {
    method: "POST",
    path: "/v1/admin/tokens/:id/revoke",
    tag: "admin",
    summary: "Revoke a minted token. Takes effect on its next request",
    handler: async (request) => {
      const id = Number(request.params.id);
      const sealed = sealedRefresh(id);
      if (!revokeToken(id)) throw notFound("no live token with that id");
      await revokeAtIndiko(sealed);
      return json({ revoked: true });
    },
  },
  {
    method: "GET",
    path: "/v1/admin/roles",
    tag: "admin",
    summary: "Every role, its capabilities and masks, and the mask groups that exist",
    handler: () =>
      json({
        capabilities: CAPABILITIES,
        roles: Object.entries(ROLES).map(([role, capabilities]) => ({
          role,
          capabilities,
          masks: isRole(role) ? masksFor(role) : [],
          editable: role !== "admin",
        })),
        masks: allMasks(),
        maskable: maskableParts(),
        indiko: config.indikoUrl ? { url: config.indikoUrl, audience: config.publicUrl } : null,
      }),
  },
  {
    method: "POST",
    path: "/v1/admin/roles/:role/masks",
    tag: "admin",
    summary: "Replace the mask groups a role is denied",
    body: '{ "masks": ["contact", "housing"] }',
    handler: async (request) => {
      const role = request.params.role;
      if (!isRole(role) || role === "admin") throw badRequest("no such editable role");
      const payload = await body<{ masks?: unknown[] }>(request);
      if (!Array.isArray(payload.masks) || !payload.masks.every(isMask)) {
        throw badRequest(
          `masks must be a list drawn from: ${allMasks()
            .map((m) => m.id)
            .join(", ")}`,
        );
      }
      setMasks(role, payload.masks);
      return json({ role, masks: masksFor(role) });
    },
  },
  {
    method: "POST",
    path: "/v1/admin/masks",
    tag: "admin",
    summary:
      "Create or replace a custom mask, built from the parts /v1/admin/roles lists as maskable",
    body: '{ "id": "no-hometown-search", "label": "Searching by department", "fields": [], "routes": [], "filters": ["department"] }',
    handler: async (request) => {
      const mask = await body<Record<string, unknown>>(request);
      const problem = checkCustomMask(mask);
      if (problem) throw badRequest(problem);
      saveCustomMask(
        mask as {
          id: string;
          label: string;
          fields: string[];
          routes: string[];
          filters: string[];
        },
      );
      return json({ mask: allMasks().find((m) => m.id === mask.id) });
    },
  },
  {
    method: "POST",
    path: "/v1/admin/masks/:id/delete",
    tag: "admin",
    summary: "Delete a custom mask. Refused while a role still carries it",
    handler: (request) => {
      const id = request.params.id ?? "";
      if (allMasks().some((mask) => mask.id === id && mask.builtin)) {
        throw badRequest("built-in masks cannot be deleted");
      }
      const using = rolesUsing(id);
      if (using.length) {
        throw badRequest(`still hidden from ${using.join(", ")}; untick it there first`);
      }
      if (!deleteCustomMask(id)) throw notFound("no custom mask with that id");
      return json({ deleted: true });
    },
  },
  {
    method: "GET",
    path: "/v1/admin/audit",
    tag: "admin",
    summary: "Who asked for what, newest first",
    query: [
      { name: "actor", description: "env, token:<id> or indiko:<sub>" },
      { name: "endpoint", description: "Route pattern, e.g. /v1/people/:id" },
      { name: "path", description: "Substring of the requested path, such as a person's id" },
      { name: "since", description: "ISO timestamp" },
      { name: "canary", description: "Only canary hits" },
      { name: "limit", description: "1-500, default 100" },
      { name: "offset", description: "Rows to skip" },
    ],
    handler: (_request, url) =>
      json(
        auditLog({
          actor: q(url, "actor"),
          endpoint: q(url, "endpoint"),
          path: q(url, "path"),
          since: q(url, "since"),
          canary: bool(url, "canary"),
          limit: num(url, "limit"),
          offset: num(url, "offset"),
        }),
      ),
  },
];
