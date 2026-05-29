import crypto from 'node:crypto';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomCode(length: number): string {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARSET[bytes[i] % CHARSET.length];
  }
  return result;
}

export function generateStepKey(): { plaintext: string; hash: string } {
  const plaintext = randomCode(6);
  const hash = hashKey(plaintext);
  return { plaintext, hash };
}

export function generateFinalKey(): { plaintext: string; hash: string } {
  const plaintext = randomCode(6);
  const hash = hashKey(plaintext);
  return { plaintext, hash };
}

export function hashKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}
