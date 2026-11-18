/**
 * Everything the engine reads from the environment, resolved once.
 *
 * Authentication is not optional. This database holds ten thousand real
 * people's rooms, phones and inferred majors, so the server refuses to start
 * until at least one way in exists: BEARER_TOKEN, indiko, or a minted token.
 */

const env = (name: string, fallback?: string): string => {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required — copy .env.example to .env and fill it in`);
};

const list = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

export const config = {
  databasePath: env("DATABASE_PATH", "data/cedarengine.db"),
  port: Number(env("PORT", "3000")),
  hostname: env("HOST", "127.0.0.1"),
  /** The admin break-glass token. Optional once indiko or minted tokens exist. */
  get bearerToken(): string | undefined {
    return process.env.BEARER_TOKEN?.trim() || undefined;
  },
  /** Where indiko lives, e.g. https://indiko.dunkirk.sh. Unset disables indiko sign-in. */
  get indikoUrl(): string | undefined {
    return process.env.INDIKO_URL?.trim().replace(/\/+$/, "") || undefined;
  },
  /** This engine's public origin: the audience tokens must carry and the base of its client ids. */
  get publicUrl(): string {
    return env("PUBLIC_URL", `http://${this.hostname}:${this.port}`).replace(/\/+$/, "");
  },
  /** Chrome extension ids allowed to sign in, for their chromiumapp.org redirect. */
  get extensionIds(): string[] {
    return list("EXTENSION_IDS");
  },
  /** Behind caddy: take the client address from X-Forwarded-For. Off, it is spoofable. */
  get trustProxy(): boolean {
    return ["1", "true", "yes"].includes((process.env.TRUST_PROXY ?? "").toLowerCase());
  },
  /** Seals the indiko sign-ins behind personal tokens. Unset disables personal tokens. */
  get secretKey(): string | undefined {
    return process.env.SECRET_KEY?.trim() || undefined;
  },
  get auditRetentionDays(): number {
    return Number(env("AUDIT_RETENTION_DAYS", "180"));
  },
};
