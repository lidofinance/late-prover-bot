/**
 * Utility functions for sanitizing sensitive data from logs and error messages
 */

/**
 * Sanitize a string by replacing sensitive patterns
 */
export function sanitizeString(str: string, secrets: string[]): string {
  let sanitized = str;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      const escapedSecret = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapedSecret, 'g');
      sanitized = sanitized.replace(regex, maskSensitiveValue(secret));
    }
  }
  sanitized = sanitizeCommonPatterns(sanitized);

  return sanitized;
}

/**
 * Sanitize an object by recursively replacing sensitive values
 */
export function sanitizeObject(obj: any, secrets: string[]): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeString(obj, secrets);
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, secrets));
  }

  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        sanitized[key] = maskSensitiveValue(String(value));
      } else {
        sanitized[key] = sanitizeObject(value, secrets);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Mask a sensitive value, showing only first and last few characters
 */
function maskSensitiveValue(value: string): string {
  if (!value || value.length <= 8) {
    return '***REDACTED***';
  }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}***REDACTED***`;
    } catch {
      // If URL parsing fails, fall through to default masking
    }
  }

  if (value.startsWith('0x')) {
    return `0x${value.slice(2, 6)}...***REDACTED***`;
  }

  // Default: show first 4 and last 4 characters
  const start = value.slice(0, 4);
  const end = value.slice(-4);
  return `${start}...${end}***REDACTED***`;
}

/**
 * Check if a key name indicates sensitive data
 */
function isSensitiveKey(key: string): boolean {
  const sensitiveKeywords = [
    'key',
    'secret',
    'password',
    'token',
    'auth',
    'private',
    'credential',
    'apikey',
    'api_key',
  ];

  const lowerKey = key.toLowerCase();
  return sensitiveKeywords.some((keyword) => lowerKey.includes(keyword));
}

/**
 * Sanitize common sensitive patterns like private keys, API keys in URLs
 */
function sanitizeCommonPatterns(str: string): string {
  let sanitized = str;

  // Private keys (0x followed by 64 hex characters)
  sanitized = sanitized.replace(/0x[0-9a-fA-F]{64}/g, (match) => `0x${match.slice(2, 6)}...***REDACTED***`);

  // API keys in query strings (e.g., ?apikey=..., ?api_key=..., &token=...)
  sanitized = sanitized.replace(/([?&])(apikey|api_key|token|key|auth)=([^&\s]+)/gi, '$1$2=***REDACTED***');

  // Basic auth in URLs (e.g., https://user:pass@domain.com)
  sanitized = sanitized.replace(/(https?:\/\/)([^:]+):([^@]+)@/gi, '$1***REDACTED***:***REDACTED***@');

  return sanitized;
}
