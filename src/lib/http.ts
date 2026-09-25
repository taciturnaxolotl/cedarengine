/** JSON in, JSON out, and one shape for errors. */

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

export const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = "bearer token required") => new HttpError(401, message);
export const notFound = (message = "not found") => new HttpError(404, message);

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  console.error(error);
  return json({ error: "internal error" }, 500);
}

/** Query-string readers that fail loudly rather than silently coercing. */
export const q = (url: URL, name: string): string | undefined =>
  url.searchParams.get(name)?.trim() || undefined;

export function num(url: URL, name: string): number | undefined {
  const raw = q(url, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw badRequest(`${name} must be a number`);
  return value;
}

export const bool = (url: URL, name: string): boolean =>
  ["1", "true", "yes"].includes((q(url, name) ?? "").toLowerCase());

/** Required, because a missing term silently returning nothing reads as a bug. */
export function required(url: URL, name: string): string {
  const value = q(url, name);
  if (!value) throw badRequest(`${name} is required`);
  return value;
}

/** A JSON request body, or a 400 that says so rather than a stack trace. */
export const body = async <T>(request: Request): Promise<T> => {
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequest("expected a JSON body");
  }
};
