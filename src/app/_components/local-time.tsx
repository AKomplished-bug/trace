"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" });
const timeOnly = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const utcDateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
const utcTimeOnly = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });

/**
 * Times are stored UTC and rendered in the viewer's time zone. The server doesn't know that zone,
 * so it renders UTC (labelled) and the browser swaps in local time after hydration.
 */
export function LocalTime({ value, mode = "datetime" }: { value: string | Date; mode?: "datetime" | "time" }) {
  const inBrowser = useSyncExternalStore(subscribe, () => true, () => false);
  const date = new Date(value);
  const iso = date.toISOString();
  const text = inBrowser
    ? (mode === "time" ? timeOnly : dateTime).format(date)
    : `${(mode === "time" ? utcTimeOnly : utcDateTime).format(date)} UTC`;
  return (
    <time dateTime={iso} title={iso} className="tabular-nums">
      {text}
    </time>
  );
}
