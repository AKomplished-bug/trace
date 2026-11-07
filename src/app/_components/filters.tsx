import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

/** A GET form of filters: works without JavaScript, and the URL is shareable. */
export function FilterBar({ action, label, filtered, children }: { action: string; label: string; filtered: boolean; children: ReactNode }) {
  return (
    <form method="get" action={action} role="search" aria-label={label} className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
      {children}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="secondary" className="h-9">
          Apply filters
        </Button>
        {filtered && (
          <Button asChild variant="ghost" className="h-9">
            <Link href={action}>Clear</Link>
          </Button>
        )}
      </div>
    </form>
  );
}

export function SelectFilter({
  name,
  label,
  value,
  allLabel,
  options,
}: {
  name: string;
  label: string;
  value: string;
  allLabel: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  const id = `filter-${name}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <NativeSelect id={id} name={name} defaultValue={value} className="min-w-44 [&_select]:h-9">
        <NativeSelectOption value="">{allLabel}</NativeSelectOption>
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

export function TextFilter({ name, label, value, placeholder }: { name: string; label: string; value: string; placeholder?: string }) {
  const id = `filter-${name}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} name={name} defaultValue={value} placeholder={placeholder} className="h-9 w-56 font-mono" />
    </div>
  );
}

/** Keyset pagination: back to the newest page, or on to older items. */
export function Pager({ newest, older }: { newest: string | null; older: string | null }) {
  if (!newest && !older) return null;
  return (
    <nav aria-label="Pages" className="flex justify-between">
      {newest ? (
        <Button asChild variant="outline" className="h-9">
          <Link href={newest}>
            <ChevronLeft aria-hidden />
            Newest
          </Link>
        </Button>
      ) : (
        <span />
      )}
      {older && (
        <Button asChild variant="outline" className="h-9">
          <Link href={older}>
            Older
            <ChevronRight aria-hidden />
          </Link>
        </Button>
      )}
    </nav>
  );
}
