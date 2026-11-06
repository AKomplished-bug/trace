"use client";

import { useEffect } from "react";

/** When the URL hash points at a timeline step or record, open the technical details inside it. */
export function OpenTargetDetails() {
  useEffect(() => {
    const open = () => {
      let id: string;
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return; // a malformed hash isn't one of our anchors
      }
      const details = id ? document.getElementById(id)?.querySelector("details") : null;
      if (details) details.open = true;
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return null;
}
