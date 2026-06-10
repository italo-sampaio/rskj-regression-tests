/**
 * Unit tests for the cache-root resolution chain. Entry validation /
 * finalization is exercised through the release- and sha-mode tests
 * (they own the cache layouts); here we lock in the precedence:
 * explicit value → RSKJ_REGRESSION_CACHE_DIR → XDG_CACHE_HOME →
 * ~/.cache/rskj-regression.
 */

import { expect } from "chai";
import { defaultCacheDir } from "../../src/build/cache.js";

describe("build/cache: defaultCacheDir", () => {
  it("prefers the explicit value over everything", () => {
    const dir = defaultCacheDir("/explicit/cache", {
      RSKJ_REGRESSION_CACHE_DIR: "/env/cache",
      XDG_CACHE_HOME: "/xdg",
    });
    expect(dir).to.equal("/explicit/cache");
  });

  it("falls back to RSKJ_REGRESSION_CACHE_DIR", () => {
    const dir = defaultCacheDir(undefined, {
      RSKJ_REGRESSION_CACHE_DIR: "/env/cache",
      XDG_CACHE_HOME: "/xdg",
    });
    expect(dir).to.equal("/env/cache");
  });

  it("falls back to XDG_CACHE_HOME/rskj-regression", () => {
    const dir = defaultCacheDir(undefined, { XDG_CACHE_HOME: "/xdg" });
    expect(dir).to.equal("/xdg/rskj-regression");
  });

  it("defaults to ~/.cache/rskj-regression when nothing is set", () => {
    const dir = defaultCacheDir(undefined, {});
    expect(dir).to.match(/\/\.cache\/rskj-regression$/);
  });
});
