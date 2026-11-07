/** Result of a POST from a client component: the JSON on success, else the API's error message. */
export type PostResult<T> = { ok: true; data: T } | { ok: false; status: number | null; code: string | null; message: string };

/** POST JSON (or nothing) and read `{ error: { message } }` on failure. A network error is status null. */
export async function postJson<T = unknown>(url: string, body?: unknown, headers: Record<string, string> = {}): Promise<PostResult<T>> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
    if (response.ok) return { ok: true, data: json as T };
    return { ok: false, status: response.status, code: json?.error?.code ?? null, message: json?.error?.message ?? "Something went wrong. Try again." };
  } catch {
    return { ok: false, status: null, code: null, message: "Couldn't reach Trace. Check your connection and try again." };
  }
}
