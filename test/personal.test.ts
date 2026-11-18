import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auditLog } from "../src/auth/audit";
import { forgetGrants, seal } from "../src/auth/grants";
import { forgetIndikoCache } from "../src/auth/indiko";
import { setMasks } from "../src/auth/masks";
import { createToken } from "../src/auth/tokens";
import { useDatabase } from "../src/db";
import { upsertPeople } from "../src/store/people";
import { call } from "./call";

const PUBLIC_URL = "https://cedarengine.test";
const INDIKO = "https://indiko.test";
const KIERAN = `${INDIKO}/u/kieran`;
const WEB = `${PUBLIC_URL}/oauth/web.json`;
const TOKENS = `${PUBLIC_URL}/oauth/tokens.json`;

/** A small fake indiko: who each access token belongs to, and which refresh tokens are live. */
let introspection: Record<string, Record<string, unknown>>;
let refreshes: Record<string, { access: string; refresh: string }>;
let codes: Record<string, { access: string; refresh?: string }>;
let revoked: string[];
let refreshCalls: string[];

const grant = (sub: string, client: string, role: string | undefined) => ({
  active: true,
  sub,
  username: sub.split("/").pop(),
  client_id: client,
  aud: PUBLIC_URL,
  ...(role ? { role } : {}),
  exp: Math.floor(Date.now() / 1000) + 3600,
});

const realFetch = globalThis.fetch;

function fakeIndiko(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  const form = new URLSearchParams(String(init?.body ?? ""));
  if (url === `${INDIKO}/.well-known/oauth-authorization-server`) {
    return Response.json({
      token_endpoint: `${INDIKO}/auth/token`,
      revocation_endpoint: `${INDIKO}/auth/token/revoke`,
    });
  }
  if (url === `${INDIKO}/auth/token/introspect`) {
    return Response.json(introspection[form.get("token") ?? ""] ?? { active: false });
  }
  if (url === `${INDIKO}/auth/token/revoke`) {
    revoked.push(form.get("token") ?? "");
    return new Response(null, { status: 200 });
  }
  if (url === `${INDIKO}/auth/token`) {
    if (form.get("grant_type") === "authorization_code") {
      const code = codes[form.get("code") ?? ""];
      if (!code || form.get("client_id") !== TOKENS || !form.get("code_verifier")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: code.access,
        refresh_token: code.refresh,
        expires_in: 3600,
      });
    }
    const presented = form.get("refresh_token") ?? "";
    refreshCalls.push(presented);
    const next = refreshes[presented];
    if (!next) return Response.json({ error: "invalid_grant" }, { status: 400 });
    delete refreshes[presented];
    return Response.json({
      access_token: next.access,
      refresh_token: next.refresh,
      expires_in: 3600,
    });
  }
  throw new Error(`unexpected fetch ${url}`);
}

const mintBody = (over: Record<string, unknown> = {}) => ({
  label: "my script",
  role: "reader",
  expiresInDays: 30,
  code: "good",
  codeVerifier: "v",
  ...over,
});

/** Mint through the API as kieran, returning the ce_ token. */
async function mintAs(webToken = "web-kieran", over: Record<string, unknown> = {}) {
  const result = await call("POST", "/v1/me/tokens", webToken, mintBody(over));
  return { result, token: result.body.token as string };
}

beforeEach(() => {
  useDatabase(":memory:");
  upsertPeople(
    [
      {
        Id: "1",
        FirstName: "Ada",
        LastName: "Lovelace",
        DormName: "Printy Hall",
        DormRoom: "P101",
        StudentType: "UG",
        StudentClass: "FR",
      },
    ],
    "2026-01-01T00:00:00.000Z",
  );
  process.env.INDIKO_URL = INDIKO;
  process.env.PUBLIC_URL = PUBLIC_URL;
  process.env.SECRET_KEY = "test secret";
  forgetIndikoCache();
  forgetGrants();
  introspection = {
    "web-kieran": grant(KIERAN, WEB, "reader"),
    "acc-1": grant(KIERAN, TOKENS, "reader"),
  };
  codes = { good: { access: "acc-1", refresh: "ref-1" } };
  refreshes = { "ref-1": { access: "acc-2", refresh: "ref-2" } };
  revoked = [];
  refreshCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    fakeIndiko(input, init)) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.INDIKO_URL;
  delete process.env.PUBLIC_URL;
  delete process.env.SECRET_KEY;
});

describe("minting", () => {
  test("a signed-in person mints a token that acts as them", async () => {
    const { result, token } = await mintAs();
    expect(result.status).toBe(201);
    expect(token.startsWith("ce_")).toBe(true);
    expect(result.body.record).toMatchObject({ role: "reader", ownerName: "kieran" });

    const me = await call("GET", "/v1/me", token);
    expect(me.body).toMatchObject({ role: "reader", client: TOKENS, name: "my script (kieran)" });
    const list = await call("GET", "/v1/me/tokens", "web-kieran");
    expect((list.body.tokens as unknown[]).length).toBe(1);
  });

  test("/v1/me says which roles a person may mint", async () => {
    introspection["web-kieran"] = grant(KIERAN, WEB, "admin");
    const me = await call("GET", "/v1/me", "web-kieran");
    const offered = (me.body.personalTokens as { mintableRoles: string[] }).mintableRoles;
    expect(offered).toEqual(
      expect.arrayContaining(["admin", "editor", "reader", "limited", "sync"]),
    );
  });

  test("nobody mints above their own role, and limited is not 'within' reader", async () => {
    expect((await mintAs("web-kieran", { role: "admin" })).result.status).toBe(400);
    introspection["web-kieran"] = grant(KIERAN, WEB, "limited");
    forgetIndikoCache();
    expect((await mintAs("web-kieran", { role: "reader" })).result.status).toBe(400);
  });

  test("only an indiko sign-in can mint; tokens cannot breed tokens", async () => {
    const plain = createToken("bot", "admin").token;
    expect((await call("POST", "/v1/me/tokens", plain, mintBody())).status).toBe(403);
    expect((await call("POST", "/v1/me/tokens", process.env.BEARER_TOKEN, mintBody())).status).toBe(
      403,
    );
  });

  test("a sign-in for somebody else is refused and handed back to indiko", async () => {
    introspection["acc-1"] = grant(`${INDIKO}/u/someone`, TOKENS, "admin");
    const { result } = await mintAs();
    expect(result.status).toBe(400);
    expect(revoked).toEqual(["ref-1"]);
  });

  test("a lifetime outside 1..90 days, or no refresh token, is refused", async () => {
    expect((await mintAs("web-kieran", { expiresInDays: 365 })).result.status).toBe(400);
    codes.good = { access: "acc-1" };
    expect((await mintAs()).result.status).toBe(400);
  });

  test("off without SECRET_KEY", async () => {
    delete process.env.SECRET_KEY;
    expect((await mintAs()).result.status).toBe(400);
    expect((await call("GET", "/v1/me", "web-kieran")).body.personalTokens).toBeNull();
  });
});

describe("live role", () => {
  test("a lowered role in indiko lowers the token at once", async () => {
    const { token } = await mintAs();
    expect((await call("GET", "/v1/people/1", token)).body.dormName).toBe("Printy Hall");

    introspection["acc-1"] = grant(KIERAN, TOKENS, "limited");
    forgetIndikoCache();
    const me = await call("GET", "/v1/me", token);
    expect(me.body.role).toBe("limited");
    expect((await call("GET", "/v1/people/1", token)).body).not.toHaveProperty("dormName");
  });

  test("a raised role in indiko does not raise the token past what it was minted as", async () => {
    const { token } = await mintAs();
    introspection["acc-1"] = grant(KIERAN, TOKENS, "admin");
    forgetIndikoCache();
    expect((await call("GET", "/v1/me", token)).body.role).toBe("reader");
    expect((await call("GET", "/v1/admin/tokens", token)).status).toBe(403);
  });

  test("a removed role cuts it off; the audit names the token and its owner", async () => {
    const { token } = await mintAs();
    await call("GET", "/v1/people/1", token);
    introspection["acc-1"] = grant(KIERAN, TOKENS, undefined);
    introspection["acc-2"] = grant(KIERAN, TOKENS, undefined);
    forgetIndikoCache();
    expect((await call("GET", "/v1/people/1", token)).status).toBe(401);
    expect(auditLog().rows[0]?.actorName).toBe("my script (kieran)");
  });

  test("a sign-in that answers as another person or another app is refused", async () => {
    const { token } = await mintAs();
    introspection["acc-1"] = grant(`${INDIKO}/u/someone`, TOKENS, "reader");
    introspection["acc-2"] = grant(KIERAN, WEB, "reader");
    forgetIndikoCache();
    expect((await call("GET", "/v1/me", token)).status).toBe(401);
  });

  test("masks follow the role, so changing reader's masks changes the token too", async () => {
    const { token } = await mintAs();
    setMasks("reader", ["housing"]);
    expect((await call("GET", "/v1/people/1", token)).body).not.toHaveProperty("dormName");
  });
});

describe("renewal", () => {
  test("a lapsed access token is renewed once, and the rotated refresh token is kept", async () => {
    const { token } = await mintAs();
    introspection["acc-1"] = { active: false };
    introspection["acc-2"] = grant(KIERAN, TOKENS, "reader");
    forgetIndikoCache();

    const [a, b] = await Promise.all([call("GET", "/v1/me", token), call("GET", "/v1/me", token)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(refreshCalls).toEqual(["ref-1"]);

    // After a restart only the stored refresh token remains; it must be the new one.
    forgetGrants();
    forgetIndikoCache();
    refreshes["ref-2"] = { access: "acc-3", refresh: "ref-3" };
    introspection["acc-3"] = grant(KIERAN, TOKENS, "reader");
    expect((await call("GET", "/v1/me", token)).status).toBe(200);
    expect(refreshCalls).toEqual(["ref-1", "ref-2"]);
  });

  test("a dead sign-in at indiko revokes the token for good", async () => {
    const { token } = await mintAs();
    introspection["acc-1"] = { active: false };
    delete refreshes["ref-1"];
    forgetIndikoCache();
    expect((await call("GET", "/v1/me", token)).status).toBe(401);
    const list = await call("GET", "/v1/me/tokens", "web-kieran");
    expect((list.body.tokens as { revokedAt: string | null }[])[0]?.revokedAt).not.toBeNull();
  });
});

describe("revoking", () => {
  test("owners revoke their own tokens, here and at indiko, and nobody else's", async () => {
    const { result, token } = await mintAs();
    const id = (result.body.record as { id: number }).id;

    introspection["web-other"] = grant(`${INDIKO}/u/other`, WEB, "reader");
    expect((await call("POST", `/v1/me/tokens/${id}/revoke`, "web-other")).status).toBe(404);

    expect((await call("POST", `/v1/me/tokens/${id}/revoke`, "web-kieran")).status).toBe(200);
    expect(revoked).toEqual(["ref-1"]);
    expect((await call("GET", "/v1/me", token)).status).toBe(401);
  });

  test("expired tokens stop working", async () => {
    const { result, token } = await mintAs("web-kieran", { expiresInDays: 1 });
    const { db } = await import("../src/db");
    db()
      .query("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", (result.body.record as { id: number }).id);
    expect((await call("GET", "/v1/me", token)).status).toBe(401);
  });

  test("the sealed refresh token is not readable without the key", async () => {
    const sealed = seal("ref-1");
    expect(sealed).not.toContain("ref-1");
    process.env.SECRET_KEY = "another key";
    const { unseal } = await import("../src/auth/grants");
    expect(() => unseal(sealed)).toThrow();
  });
});
