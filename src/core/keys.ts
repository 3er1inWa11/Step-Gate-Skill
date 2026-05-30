import crypto from 'node:crypto';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function randomCode(length: number): string {
  const bytes = crypto.randomBytes(length * 2); // oversample to avoid modulo bias
  let result = '';
  let byteIdx = 0;
  for (let i = 0; i < length; i++) {
    // rejection sampling: skip bytes >= 252 (the largest multiple of 36 under 256)
    let val: number;
    do {
      val = bytes[byteIdx++];
    } while (val >= 252 && byteIdx < bytes.length);
    result += CHARSET[val % CHARSET.length];
  }
  return result;
}

export function generateStepKey(): { plaintext: string; hash: string } {
  const plaintext = randomCode(6);
  const hash = hashKey(plaintext);
  return { plaintext, hash };
}

/** Task-level key — proves all steps in a task were checkpointed */
export function generateTaskKey(): { plaintext: string; hash: string } {
  const plaintext = randomCode(6);
  return { plaintext, hash: hashKey(plaintext) };
}

/** @deprecated use generateTaskKey */
export const generateFinalKey = generateTaskKey;

/** Node-level key — system-generated receipt when all tasks in a node are done */
export function generateNodeKey(): { plaintext: string; hash: string } {
  const plaintext = randomCode(6);
  return { plaintext, hash: hashKey(plaintext) };
}

export function hashKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}
