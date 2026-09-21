import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "../lib/http.js";

/** /verify — the record Researcher sells. Everything else is in lib/. */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handle(req, res);
}
