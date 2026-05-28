import crypto from 'node:crypto';

export function generateStepKey(): { plaintext: string; hash: string } {
  const random = crypto.randomBytes(32).toString('hex');
  const plaintext = `sg_step_${random}`;
  const hash = hashKey(plaintext);
  return { plaintext, hash };
}

export function generateFinalKey(): { plaintext: string; hash: string } {
  const random = crypto.randomBytes(32).toString('hex');
  const plaintext = `sg_final_${random}`;
  const hash = hashKey(plaintext);
  return { plaintext, hash };
}

export function hashKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}
