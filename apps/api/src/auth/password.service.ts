import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class PasswordService {
  /**
   * Hache un mot de passe avec Salt aléatoire (PBKDF2 SHA-512)
   */
  async hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const iterations = 100000;
    const keylen = 64;
    const digest = 'sha512';

    return new Promise((resolve, reject) => {
      crypto.pbkdf2(password, salt, iterations, keylen, digest, (err, derivedKey) => {
        if (err) reject(err);
        resolve(`${iterations}:${salt}:${derivedKey.toString('hex')}`);
      });
    });
  }

  /**
   * Vérifie un mot de passe en temps constant contre les attaques temporelles
   */
  async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;

    const iterations = parseInt(parts[0], 10);
    const salt = parts[1];
    const originalHash = parts[2];

    return new Promise((resolve) => {
      crypto.pbkdf2(password, salt, iterations, 64, 'sha512', (err, derivedKey) => {
        if (err) return resolve(false);
        const derivedHash = derivedKey.toString('hex');
        try {
          resolve(crypto.timingSafeEqual(Buffer.from(derivedHash), Buffer.from(originalHash)));
        } catch {
          resolve(false);
        }
      });
    });
  }
}
