/**
 * version.ts is read from package.json — keep them in sync forever.
 *
 * Pre-v2.3.0 src/version.ts held a hardcoded "2.0.0" and drifted across
 * v2.1.0 and v2.2.0. The fix: import package.json directly. This test
 * locks that contract so a future `npm version` bump never silently
 * de-syncs the runtime constant.
 */

import { describe, it, expect } from "vitest";
import { VERSION } from "../src/version.js";
import pkg from "../package.json" with { type: "json" };

describe("VERSION matches package.json", () => {
  it("the runtime constant equals pkg.version (no manual drift)", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("VERSION is a non-empty semver-shaped string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
