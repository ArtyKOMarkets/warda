import { useEffect, useState } from "react";

/* Hash routes, so the console is one static file on any host. */
export function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, "") || "overview").split("/").map(decodeURIComponent);
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => { setR(read()); window.scrollTo({ top: 0 }); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const href = (...parts: string[]) => "#/" + parts.map(encodeURIComponent).join("/");
export const go = (...parts: string[]) => { location.hash = href(...parts).slice(1); };
