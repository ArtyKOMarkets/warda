import type { IncomingMessage, ServerResponse } from "node:http";

import { serve } from "../vendor.js";

/** /weather — the price and body live in vendor.ts, keyed by this path. */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return serve("/weather", req, res);
}
