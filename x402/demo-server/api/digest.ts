import type { IncomingMessage, ServerResponse } from "node:http";

import { serve } from "../vendor.js";

/** /digest — sold by agent #001, which is paid at WARDA_AGENT_001_PAYEE, not
 *  at the demo vendor's address. The price and body live in vendor.ts. */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return serve("/digest", req, res);
}
