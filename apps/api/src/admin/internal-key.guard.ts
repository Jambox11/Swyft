import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Stable error codes for the fee-collector auth surface (#965).
 * Deny-by-default: any failure to prove FEE_COLLECTOR_AUTH is rejected.
 */
export const FEE_COLLECTOR_AUTH_ERRORS = {
  MISSING_KEY: 'FEE_COLLECTOR_AUTH_MISSING_KEY',
  INVALID_KEY: 'FEE_COLLECTOR_AUTH_INVALID_KEY',
  WRONG_ROLE: 'FEE_COLLECTOR_AUTH_WRONG_ROLE',
  EXPIRED: 'FEE_COLLECTOR_AUTH_EXPIRED',
  NOT_CONFIGURED: 'FEE_COLLECTOR_AUTH_NOT_CONFIGURED',
} as const;

export type FeeCollectorAuthErrorCode =
  (typeof FEE_COLLECTOR_AUTH_ERRORS)[keyof typeof FEE_COLLECTOR_AUTH_ERRORS];

/**
 * Constant-time comparison that never throws on length mismatch.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Guard enforcing FEE_COLLECTOR_AUTH for fee-collector entrypoints.
 *
 * Invariants:
 *  - Deny-by-default: missing/expired/wrong-role credentials are rejected.
 *  - Fail-closed: if the expected key is not configured, all requests are denied.
 *  - No bypass: untrusted clients cannot satisfy the check without the key.
 *  - Correlation id is surfaced for ops without leaking the secret.
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ??
      (req.headers['x-request-id'] as string | undefined) ??
      'unknown';

    const expected = process.env.FEE_COLLECTOR_AUTH ?? process.env.INTERNAL_API_KEY;
    if (!expected) {
      // Fail-closed: no configured secret means no privileged access.
      throw new UnauthorizedException({
        code: FEE_COLLECTOR_AUTH_ERRORS.NOT_CONFIGURED,
        message: 'Fee collector auth is not configured',
        correlationId,
      });
    }

    const key = req.headers['x-internal-key'] as string | undefined;
    if (!key) {
      throw new UnauthorizedException({
        code: FEE_COLLECTOR_AUTH_ERRORS.MISSING_KEY,
        message: 'Missing fee collector credentials',
        correlationId,
      });
    }

    if (!safeEqual(key, expected)) {
      throw new UnauthorizedException({
        code: FEE_COLLECTOR_AUTH_ERRORS.INVALID_KEY,
        message: 'Invalid fee collector credentials',
        correlationId,
      });
    }

    // Optional role/expiry enforcement when the caller presents a scoped token.
    const role = req.headers['x-fee-collector-role'] as string | undefined;
    if (role && role !== 'fee-collector') {
      throw new ForbiddenException({
        code: FEE_COLLECTOR_AUTH_ERRORS.WRONG_ROLE,
        message: 'Caller lacks fee-collector role',
        correlationId,
      });
    }

    const expiresAt = req.headers['x-fee-collector-expires-at'] as string | undefined;
    if (expiresAt) {
      const ts = Number(expiresAt);
      if (!Number.isFinite(ts) || ts <= Date.now()) {
        throw new UnauthorizedException({
          code: FEE_COLLECTOR_AUTH_ERRORS.EXPIRED,
          message: 'Fee collector credentials expired',
          correlationId,
        });
      }
    }

    return true;
  }
}
