// SHA-256 whose progress can be saved between queue invocations. WebCrypto can't export
// a running hash, and Workers can't compile WASM at runtime, so this is @noble/hashes
// (pure JS, ~300 MB/s) with its state read and restored directly.
//
// We only save at part boundaries, and parts are multiples of 64 bytes (the block size),
// so the state is just the eight working words and the byte count. noble's fields are
// TypeScript-protected but plain properties at runtime; the version is pinned exactly in
// package.json and test/sha256.test.js checks the round trip.

import { sha256 } from "@noble/hashes/sha2.js";

export function newHash() {
  return sha256.create();
}

export function saveHash(hash) {
  if (hash.pos !== 0) {
    throw new Error("can only save a hash at a 64-byte boundary");
  }
  return { words: hash.get(), length: hash.length };
}

export function loadHash({ words, length }) {
  const hash = sha256.create();
  hash.set(...words);
  hash.length = length;
  return hash;
}

export function hexDigest(hash) {
  return [...hash.digest()].map((b) => b.toString(16).padStart(2, "0")).join("");
}
