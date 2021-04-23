/**
 * Flow type parameters that have a variance annotation (`+` or `-`) that we feel comfortable
 * dropping the variance annotation from.
 */
export const typeParameterWithVariance = new Set<string>([
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
]);
