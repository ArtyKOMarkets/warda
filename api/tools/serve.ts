/**
 * The repo's entry point, so `npm run serve` reads the same way as every other
 * package here. The CLI itself lives in `src/serve.ts` because it is published:
 * `warda-verify` has to exist in `dist`, and a bin outside `rootDir` does not.
 */
import "../src/serve.ts";
