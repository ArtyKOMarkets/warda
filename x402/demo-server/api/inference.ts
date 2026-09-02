import type { IncomingMessage, ServerResponse } from "node:http";

import { serve } from "../vendor.js";

/** /inference — the price and body live in vendor.ts, keyed by this path. */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return serve("/inference", req, res);
}
