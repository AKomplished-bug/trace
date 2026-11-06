/** The only API error helper: errors are always `{ error: { code, message } }`, never internal detail. */
export function errorResponse(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}
