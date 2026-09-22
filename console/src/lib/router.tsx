import { useEffect, useState } from "react";

/* Hash routes, so the console is one static file on any host.

   The classic console lived at this same URL, and its links are out in the
   world: in Telegram messages the runner sent, in bookmarks, in the MCP
   tool's replies. Its hashes land somewhere sensible here, or in the classic
   console at /app-classic when this one has no screen for them yet. */
const LEGACY: Record<string, string | ((rest: string[]) => string)> = {
  dash: "overview", fleet: "agents", hagents: "agents", hosted: "new",
  refusals: "activity/blocked", registry: "services",
  agent: (r) => (r[0] ? `agents/${/^\d+$/.test(r[0]) ? "p" : "h"}:${r[0]}` : "agents"),
};
const CLASSIC_ONLY = new Set(["admin"]);

function legacy() {
  const [head = "", ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  if (CLASSIC_ONLY.has(head)) { location.replace(`/app-classic${location.hash}`); return; }
  const to = LEGACY[head];
  if (to) history.replaceState(null, "", `#/${typeof to === "function" ? to(rest) : to}`);
}

export function useRoute(): string[] {
  legacy();
  const read = () => (location.hash.replace(/^#\/?/, "") || "overview").split("/").map(decodeURIComponent);
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => { legacy(); setR(read()); window.scrollTo({ top: 0 }); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const href = (...parts: string[]) => "#/" + parts.map(encodeURIComponent).join("/");
export const go = (...parts: string[]) => { location.hash = href(...parts).slice(1); };
