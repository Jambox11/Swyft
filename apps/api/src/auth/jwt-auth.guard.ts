import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { verify, VerifyOptions } from 'jsonwebtoken';

interface JwtPayload {
  sub?: string;
  walletAddress?: string;
  wallet?: string;
  address?: string;
  iss?: string;
  aud?: string | string[];
  role?: string;
  roles?: string[];
  exp?: number;
}

interface RequestWithUser {
  headers: { authorization?: string };
  user?: { walletAddress: string; roles: string[] };
}

/**
 * Roles permitted to invoke the fee-collector money path.
 * Deny-by-default: any token without one of these roles is rejected.
 */
const FEE_COLLECTOR_ROLES = ['fee-collector', 'admin'];

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing JWT');
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new UnauthorizedException('JWT secret not configured');
    }

    const options: VerifyOptions = {};
    if (process.env.JWT_ISSUER) {
      options.issuer = process.env.JWT_ISSUER;
    }
    if (process.env.JWT_AUDIENCE) {
      options.audience = process.env.JWT_AUDIENCE;
    }

    let payload: JwtPayload;
    try {
      payload = verify(token, secret, options) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid JWT');
    }

    // Fail-closed on expiry: reject tokens without a valid future exp claim.
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
      throw new UnauthorizedException('JWT expired or missing exp claim');
    }

    const walletAddress =
      payload.walletAddress ??
      payload.wallet ??
      payload.address ??
      payload.sub;

    if (!walletAddress || typeof walletAddress !== 'string') {
      throw new UnauthorizedException('JWT is missing wallet address claim');
    }

    const roles = Array.isArray(payload.roles)
      ? payload.roles
      : payload.role
        ? [payload.role]
        : [];

    // Deny-by-default: untrusted clients cannot bypass FEE_COLLECTOR_AUTH.
    if (!roles.some((role) => FEE_COLLECTOR_ROLES.includes(role))) {
      throw new ForbiddenException('Insufficient role for fee collector');
    }

    req.user = { walletAddress, roles };
    return true;
  }
}
