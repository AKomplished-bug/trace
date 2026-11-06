import { AppHeader } from "../_components/app-header";
import { requirePageSession } from "../_lib/auth";

export default async function OpsHome() {
  const session = await requirePageSession("OPS");
  return (
    <div className="min-h-full">
      <AppHeader home="/ops" who={`${session.name} · Ops`} nav={null} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-lg font-semibold tracking-tight">Operations</h1>
        <p className="mt-2 max-w-prose text-sm text-neutral-600">
          You&apos;re signed in as Ops. The reconciliation queue, investigations and the event viewer are not built yet;
          they will live here.
        </p>
      </main>
    </div>
  );
}
