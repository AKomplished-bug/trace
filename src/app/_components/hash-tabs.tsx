"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Tabs whose panels stay mounted (hidden when inactive), so in-page links such as #step-… or
 * #event-… from the money graph still resolve: when the URL hash points inside a panel, that
 * panel is selected and the target scrolled into view.
 */
export function HashTabs({ label, tabs, defaultValue, children }: { label: string; tabs: Array<{ value: string; label: string }>; defaultValue: string; children: ReactNode }) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    const select = () => {
      let id: string;
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return; // a malformed hash isn't one of our anchors
      }
      const target = id ? document.getElementById(id) : null;
      const panel = target?.closest<HTMLElement>("[data-tab]");
      if (!target || !panel?.dataset.tab) return;
      setValue(panel.dataset.tab);
      requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    };
    const frame = requestAnimationFrame(select);
    window.addEventListener("hashchange", select);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", select);
    };
  }, []);

  return (
    <Tabs value={value} onValueChange={setValue} className="gap-4">
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <TabsList aria-label={label} className="h-10! w-full justify-start sm:w-fit">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="px-3">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {children}
    </Tabs>
  );
}
