/** Next.js startup hook: validate the environment before serving, so a missing key fails fast with its name. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { config } = await import("./lib/config");
    config();
  }
}
