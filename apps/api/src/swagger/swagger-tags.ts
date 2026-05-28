/**
 * Central list of allowed Swagger/OpenAPI tag names for the API.
 *
 * Use `SwyftSwaggerTag` for type-safe references to tag names.
 */
export const SWYFT_SWAGGER_TAGS = [
  'pools',
  'positions',
  'prices',
  'search',
  'webhooks',
  'auth',
] as const;

/**
 * Union type of all allowed Swagger/OpenAPI tag names.
 */
export type SwyftSwaggerTag = (typeof SWYFT_SWAGGER_TAGS)[number];
