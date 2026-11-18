import { pipeline } from "../src/lib/pipeline";
import { routes } from "../src/routes";

/** Dispatch the way Bun would: match the route pattern, fill params, run the pipeline. */
export async function call(
  method: "GET" | "POST",
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(path, "http://engine.test");
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = new RegExp(`^${route.path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    const request = new Request(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    Object.assign(request, { params: match.groups ?? {} });
    const response = await pipeline(route)(request);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }
  throw new Error(`no route for ${method} ${path}`);
}
