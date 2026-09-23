import { useEffect, useRef } from "react";

/* A grant coming to life is the one moment in this console worth marking.
   Twenty pieces of paper, two seconds, and nothing left behind — skipped
   entirely when the person asked for less motion. */
const COLORS = ["#14d7c1", "#3ff0dc", "#3ecf8e", "#6aa7ff", "#f0b429"];

export function Celebrate({ on }: { on: boolean }) {
  const fired = useRef(false);
  useEffect(() => {
    if (!on || fired.current) return;
    fired.current = true;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:60;overflow:hidden";
    document.body.appendChild(host);
    for (let i = 0; i < 20; i++) {
      const c = document.createElement("i");
      const dx = (Math.random() - 0.5) * 40, t = 1.6 + Math.random() * 1.2;
      c.style.cssText = `position:absolute;top:-6vh;left:${Math.random() * 100}vw;width:7px;height:11px;border-radius:1px;` +
        `background:${COLORS[i % COLORS.length]};opacity:.9;animation:fall ${t}s cubic-bezier(.25,.6,.4,1) ${Math.random() * 0.3}s forwards;` +
        `--dx:${dx}vw;--r:${Math.round(Math.random() * 900 - 450)}deg`;
      host.appendChild(c);
    }
    const t = setTimeout(() => host.remove(), 3400);
    return () => { clearTimeout(t); host.remove(); };
  }, [on]);
  return null;
}
