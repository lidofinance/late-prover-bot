import { commonPatterns, satanizer } from '@lidofinance/satanizer';

/**
 * Builds a masking function for the given secret values on top of the common patterns of satanizer.
 * The result replaces every match inside strings, arrays and objects. The traversal is bounded by depth and size
 * (satanizer limits); the parts it cuts off are replaced with a marker, never passed through.
 */
export const buildMask = (secrets: string[]) => satanizer([...commonPatterns, ...secrets]);
