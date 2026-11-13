// Backup file: everything needed to restore the extension (settings, all API keys, wallet key,
// launch history). Optionally encrypted with a password (PBKDF2-SHA256 + AES-GCM).

const ITER = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes) => {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function keyFrom(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function makeBackup(data, { password, extVersion } = {}) {
  const head = { app: "hatchr", format: 1, exportedAt: new Date().toISOString(), extVersion: extVersion || "" };
  if (!password) return { ...head, encrypted: false, data };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, ITER);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { ...head, encrypted: true, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(salt) }, iv: b64(iv), ciphertext: b64(ct) };
}

/** Returns the backup's data object. Throws with a readable message. */
export async function openBackup(file, password) {
  let j = file;
  if (typeof file === "string") {
    try { j = JSON.parse(file); } catch { throw new Error("That file isn't a Hatchr backup (not JSON)."); }
  }
  if (!j || (j.app !== "hatchr" && j.app !== "tweet2coin")) throw new Error("That file isn't a Hatchr backup."); // tweet2coin = old name
  if (j.format !== 1) throw new Error("This backup was made by a newer version of Hatchr. Update the extension first.");
  if (!j.encrypted) {
    if (!j.data || typeof j.data !== "object") throw new Error("The backup is empty or damaged.");
    return j.data;
  }
  if (!password) {
    const e = new Error("This backup is password-protected. Type its password and import again.");
    e.needsPassword = true;
    throw e;
  }
  try {
    const key = await keyFrom(password, unb64(j.kdf.salt), j.kdf.iterations || ITER);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(j.iv) }, key, unb64(j.ciphertext));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error("Wrong password, or the backup file is damaged.");
  }
}
