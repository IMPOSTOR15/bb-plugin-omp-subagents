// Bounded file reads for the host: never load a whole multi-megabyte
// transcript, and never cut inside a line or a multi-byte character.
import { lstat, open } from "node:fs/promises";

const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** The size of a regular file (never a symlink) within the bound, else null. */
export async function regularFileSize(path: string): Promise<number | null> {
  try {
    const st = await lstat(path);
    return st.isFile() && st.size <= MAX_FILE_BYTES ? st.size : null;
  } catch {
    return null;
  }
}

/** Bytes kept from the start of an oversized file: session_init carries a ~25 KB system prompt. */
const HEAD_BYTES = 256 * 1024;

/**
 * Read a transcript without loading all of it. A file within `maxBytes` is
 * read whole; a larger one yields its head (session_init and the assignment)
 * and its tail (live progress). Both cuts land on newlines, so no line is
 * half-read and no multi-byte character is split.
 */
export async function readLines(path: string, maxBytes: number): Promise<string[]> {
  const size = await regularFileSize(path);
  if (size === null) throw new Error("not a regular file");
  const handle = await open(path, "r");
  try {
    if (size <= maxBytes) {
      const whole = Buffer.alloc(size);
      await handle.read(whole, 0, size, 0);
      return whole.toString("utf8").split("\n");
    }
    const headLen = Math.min(HEAD_BYTES, Math.floor(maxBytes / 2));
    const tailLen = maxBytes - headLen;
    const head = Buffer.alloc(headLen);
    await handle.read(head, 0, headLen, 0);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);
    // Head: stop after its last newline. Tail: start after its first newline.
    const headEnd = head.lastIndexOf(0x0a);
    const tailStart = tail.indexOf(0x0a);
    const headText = headEnd === -1 ? "" : head.subarray(0, headEnd).toString("utf8");
    const tailText = tailStart === -1 ? "" : tail.subarray(tailStart + 1).toString("utf8");
    return [...headText.split("\n"), ...tailText.split("\n")];
  } finally {
    await handle.close();
  }
}

/** First `bytes` of a regular file as text, cut on a code-point boundary. */
export async function readHead(path: string, bytes: number): Promise<{ text: string; truncated: boolean } | null> {
  const size = await regularFileSize(path);
  if (size === null) return null;
  const handle = await open(path, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, 0);
    let end = len;
    // Back off a split UTF-8 sequence: continuation bytes are 10xxxxxx.
    if (size > len) while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end -= 1;
    if (size > len && end > 0 && (buf[end - 1]! & 0x80) !== 0) end -= 1;
    return { text: buf.subarray(0, end).toString("utf8"), truncated: size > len };
  } finally {
    await handle.close();
  }
}

