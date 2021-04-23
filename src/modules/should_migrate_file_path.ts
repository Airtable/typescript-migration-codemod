import path from 'path';
import minimatch from 'minimatch';
import builtinModules from 'builtin-modules';
import {SOURCE} from '../paths';

const builtinModuleSet = new Set(builtinModules);

const patternsToIgnore: Array<string> = [
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
];

const patternsToIgnoreExceptions = new Set<string>([
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
]);

/**
 * Should we migrate the provided file path? We migrate all of the files which will be transpiled
 * by Babel.
 */
export default function shouldMigrateFilePath(target: string): boolean {
    if (path.extname(target) !== '.js') {
        return false;
    }

    if (builtinModuleSet.has(target)) {
        return false;
    }

    target = path.relative(SOURCE, target);

    if (patternsToIgnoreExceptions.has(target)) {
        return true;
    }

    for (const pattern of patternsToIgnore) {
        if (minimatch(target, pattern)) {
            return false;
        }
    }

    return true;
}
