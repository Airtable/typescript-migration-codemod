import path from 'path';

/**
 * The current working directory of the process.
 */
export const CWD = process.cwd();

/**
 * The Hyperbase source directory.
 */
export const SOURCE = path.resolve(__dirname, '../../..');

/**
 * Directories we ignore when migrating code.
 */
export const IGNORED_DIRS = [
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
];
