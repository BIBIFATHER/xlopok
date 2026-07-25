/**
 * Domain errors. Bitrix24 REST failures are translated into these before they
 * leave the adapter, so no raw portal payload (which can contain the webhook
 * URL) is ever surfaced to a tool caller.
 */
export type DomainErrorCode =
  | 'AUTH'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'WRITE_DISABLED'
  | 'CONFIRMATION_REQUIRED'
  | 'DUPLICATE_FOUND'
  | 'INTERNAL';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class AuthError extends DomainError {
  constructor(message = 'Unauthorized') {
    super('AUTH', message);
    this.name = 'AuthError';
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: number | string) {
    super('NOT_FOUND', `${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class WriteDisabledError extends DomainError {
  constructor(tool: string) {
    super('WRITE_DISABLED', `Write operations are disabled (WRITE_ENABLED=false); ${tool} is unavailable`);
    this.name = 'WriteDisabledError';
  }
}

export class ConfirmationRequiredError extends DomainError {
  constructor(action: string) {
    super('CONFIRMATION_REQUIRED', `${action} requires explicit human confirmation`);
    this.name = 'ConfirmationRequiredError';
  }
}

/** Map a Bitrix24 `error` code to a domain error. Never echoes the description verbatim. */
export function mapBitrixError(code: string, httpStatus?: number): DomainError {
  const c = code.toUpperCase();

  // REST v3 reports validation problems with long BITRIX_REST_V3_EXCEPTION_*
  // codes; they are all caller mistakes, not portal failures.
  if (c.startsWith('BITRIX_REST_V3_EXCEPTION')) {
    if (c.includes('PAGINATION')) {
      return new DomainError('INVALID_REQUEST', 'Bitrix24 rejected the pagination parameters', {
        code: c,
      });
    }
    if (c.includes('ORDER')) {
      return new DomainError('INVALID_REQUEST', 'Bitrix24 rejected the sort parameters', { code: c });
    }
    return new DomainError('INVALID_REQUEST', 'Bitrix24 rejected the request payload', { code: c });
  }

  switch (c) {
    case 'NO_AUTH_FOUND':
    case 'INVALID_CREDENTIALS':
    case 'EXPIRED_TOKEN':
      return new DomainError('AUTH', 'Bitrix24 rejected the gateway credentials');
    case 'INSUFFICIENT_SCOPE':
    case 'ACCESS_DENIED':
    case 'USER_ACCESS_ERROR':
    case 'ALLOWED_ONLY_INTRANET_USER':
      return new DomainError('FORBIDDEN', 'Bitrix24 denied access to this resource or method');
    case 'NOT_FOUND':
    case 'OWNER_NOT_FOUND':
      return new DomainError('NOT_FOUND', 'Requested Bitrix24 record does not exist');
    case 'QUERY_LIMIT_EXCEEDED':
    case 'OVERLOAD_LIMIT':
    case 'OPERATION_TIME_LIMIT':
      return new DomainError('RATE_LIMITED', 'Bitrix24 rate limit reached', undefined, true);
    case 'INTERNAL_SERVER_ERROR':
    case 'ERROR_UNEXPECTED_ANSWER':
    case 'PORTAL_DELETED':
      return new DomainError('UPSTREAM_UNAVAILABLE', 'Bitrix24 is temporarily unavailable', undefined, true);
    default:
      if (httpStatus && httpStatus >= 500) {
        return new DomainError('UPSTREAM_UNAVAILABLE', 'Bitrix24 returned a server error', { code: c }, true);
      }
      return new DomainError('INVALID_REQUEST', 'Bitrix24 rejected the request', { code: c });
  }
}
