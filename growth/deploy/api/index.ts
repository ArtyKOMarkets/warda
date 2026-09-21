import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "../lib/http.js";

/** / — what is sold, for how much, and who runs it. Free. */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handle(req, res);
}
