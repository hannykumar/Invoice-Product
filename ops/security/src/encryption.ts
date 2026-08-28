import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptionKeyProvider {
  key(keyId: string): Promise<Buffer>;
}

export interface EncryptedPayload {
  readonly algorithm: "aes-256-gcm";
  readonly keyId: string;
  readonly iv: string;
  readonly authenticationTag: string;
  readonly ciphertext: string;
}

export class StaticEncryptionKeyProvider implements EncryptionKeyProvider {
  readonly #keys: ReadonlyMap<string, Buffer>;

  constructor(keys: ReadonlyMap<string, Buffer>) {
    this.#keys = new Map([...keys].map(([id, value]) => [id, Buffer.from(value)]));
  }

  async key(keyId: string): Promise<Buffer> {
    const value = this.#keys.get(keyId);
    if (!value) throw new Error("ENCRYPTION_KEY_UNAVAILABLE");
    return Buffer.from(value);
  }
}

export class AesGcmEncryptionService {
  readonly #provider: EncryptionKeyProvider;

  constructor(provider: EncryptionKeyProvider) {
    this.#provider = provider;
  }

  async encrypt(plaintext: Uint8Array, keyId: string, associatedData: string): Promise<EncryptedPayload> {
    const key = await this.#provider.key(keyId);
    requireAes256Key(key);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Object.freeze({
      algorithm: "aes-256-gcm" as const,
      keyId,
      iv: iv.toString("base64"),
      authenticationTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  }

  async decrypt(payload: EncryptedPayload, associatedData: string): Promise<Buffer> {
    if (payload.algorithm !== "aes-256-gcm") throw new Error("UNSUPPORTED_ENCRYPTION_ALGORITHM");
    const key = await this.#provider.key(payload.keyId);
    requireAes256Key(key);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(payload.authenticationTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]);
  }
}

function requireAes256Key(key: Buffer): void {
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY_MUST_BE_32_BYTES");
}
