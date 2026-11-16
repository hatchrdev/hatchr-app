// Some Solana libraries reach for a global Buffer, which Chrome's background has not got. Imported first.
import { Buffer } from "buffer";
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
