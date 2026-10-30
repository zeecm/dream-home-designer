import { describe, expect, it } from 'vitest';
import { hashBlob, hashOfKey, keyOfHash } from './assets';

describe('plan image keys', () => {
  it('hashes a blob to hex SHA-256 and round-trips it through a key', async () => {
    const hash = await hashBlob(new Blob(['abc']));
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashOfKey(keyOfHash(hash))).toBe(hash);
  });

  it('treats older browser-only keys as having no hash', () => {
    expect(hashOfKey('img_abc123')).toBeNull();
    expect(hashOfKey('sha256:nothex')).toBeNull();
  });
});
