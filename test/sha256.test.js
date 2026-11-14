import { describe, expect, it } from "vitest";
import { hexDigest, loadHash, newHash, saveHash } from "../src/sha256.js";
import { digestOf, patterned } from "./fakes.js";

describe("resumable sha256", () => {
  it("matches WebCrypto when saved and restored at every part boundary", async () => {
    const bytes = patterned(64 * 1000 + 17);
    const part = 64 * 97;
    let state = saveHash(newHash());
    for (let at = 0; at < bytes.length; at += part) {
      const hash = loadHash(JSON.parse(JSON.stringify(state))); // as stored in R2
      hash.update(bytes.subarray(at, at + part));
      if (at + part >= bytes.length) {
        expect("sha256:" + hexDigest(hash)).toBe(await digestOf(bytes));
        return;
      }
      state = saveHash(hash);
    }
  });

  it("refuses to save mid-block", () => {
    const hash = newHash();
    hash.update(new Uint8Array(10));
    expect(() => saveHash(hash)).toThrow(/64-byte/);
  });
});
