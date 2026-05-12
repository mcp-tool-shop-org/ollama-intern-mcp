/**
 * Single source of version truth — read from package.json at module load.
 *
 * Prior to v2.3.0 this file held a hardcoded string and drifted silently
 * across v2.1.0 and v2.2.0 (both shipped with VERSION === "2.0.0"). Reading
 * the manifest directly removes the failure mode: a `npm version` bump
 * updates the runtime constant automatically. tsconfig has
 * `resolveJsonModule: true` and Node 22 ESM supports JSON imports with
 * `with { type: "json" }`.
 */

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
