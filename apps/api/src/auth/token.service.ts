import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { UserSessionDto } from '@cp-engineer/shared-types';

@Injectable()
export class TokenService {
  // Clé secrète serveur issue de l'environnement (avec fallback sécurisé pour le staging)
  private readonly secretKey: string = process.env.JWT_SECRET || 'cp_saas_super_secret_key_server_side_only_2026';

  /**
   * Crée un token de session signé (HMAC-SHA256) sans dépendance tierce vulnérable
   */
  generateSessionToken(payload: UserSessionDto): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // 7 jours
    const data = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(`${header}.${data}`)
      .digest('base64url');

    return `${header}.${data}.${signature}`;
  }

  /**
   * Vérifie la validité et la signature du token de session
   */
  verifySessionToken(token: string): UserSessionDto {
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('Token de session manquant.');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Format de token invalide.');
    }

    const [header, data, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', this.secretKey)
      .update(`${header}.${data}`)
      .digest('base64url');

    if (signature !== expectedSignature) {
      throw new UnauthorizedException('Signature du token invalide (tentative d\'altération).');
    }

    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        throw new UnauthorizedException('Session expirée. Veuillez vous reconnecter.');
      }
      return payload as UserSessionDto;
    } catch {
      throw new UnauthorizedException('Contenu du token illisible.');
    }
  }
}
