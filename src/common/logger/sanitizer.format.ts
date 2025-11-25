import { format } from 'winston';

import { sanitizeObject, sanitizeString } from '../utils/sanitizer';

/**
 * Winston format that applies our advanced sanitization to log messages
 */
export const sanitizerFormat = (secrets: string[]) => {
  return format((info) => {
    // Sanitize the message
    if (typeof info.message === 'string') {
      info.message = sanitizeString(info.message, secrets);
    } else if (typeof info.message === 'object') {
      info.message = sanitizeObject(info.message, secrets);
    }

    // Sanitize any additional metadata/context
    if (info.context && typeof info.context === 'object') {
      info.context = sanitizeObject(info.context, secrets);
    }

    // Sanitize stack traces
    if (info.stack && typeof info.stack === 'string') {
      info.stack = sanitizeString(info.stack, secrets);
    }

    // Sanitize any other string or object fields
    for (const [key, value] of Object.entries(info)) {
      if (['level', 'timestamp', 'message', 'context', 'stack'].includes(key)) {
        continue; // Already handled above
      }

      if (typeof value === 'string') {
        info[key] = sanitizeString(value, secrets);
      } else if (typeof value === 'object' && value !== null) {
        info[key] = sanitizeObject(value, secrets);
      }
    }

    return info;
  })();
};
