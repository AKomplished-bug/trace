/** Load balancer health check: the web process is up. Touches no database or provider. */
export function GET(): Response {
  return Response.json({ status: "ok" });
}
