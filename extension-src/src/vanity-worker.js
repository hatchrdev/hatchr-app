// Web worker: tries random wallets until the address starts/ends with what the user asked for.
// Keys are made with the same ed25519 library Solana uses and never leave this browser.
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { vanityMatch } from "./lib/vanity.js";

let job = 0;

export function tryBatch(n, prefix, suffix, caseSensitive) {
  for (let i = 0; i < n; i++) {
    const seed = ed25519.utils.randomPrivateKey();
    const pub = ed25519.getPublicKey(seed);
    const addr = bs58.encode(pub);
    if (vanityMatch(addr, prefix, suffix, caseSensitive)) {
      const sk = new Uint8Array(64);
      sk.set(seed);
      sk.set(pub, 32);
      return { pub: addr, secret: bs58.encode(sk), tried: i + 1 };
    }
  }
  return null;
}

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
  self.onmessage = (e) => {
    const m = e.data || {};
    const id = ++job;
    if (m.stop) return;
    const step = () => {
      if (id !== job) return;
      const t0 = performance.now();
      let tried = 0;
      while (performance.now() - t0 < 250) {
        const hit = tryBatch(50, m.prefix || "", m.suffix || "", !!m.caseSensitive);
        if (hit) { self.postMessage({ found: { pub: hit.pub, secret: hit.secret }, tried: tried + hit.tried }); return; }
        tried += 50;
      }
      self.postMessage({ tried });
      setTimeout(step, 0);
    };
    step();
  };
}
