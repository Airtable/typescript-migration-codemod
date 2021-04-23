import path from 'path';
import builtinModules from 'builtin-modules';
import {CWD} from '../paths';
import {babelInteropDefaultImportOverrides} from './allowlists';

const builtinModuleSet = new Set(builtinModules);

const cache = new Map<string, boolean | null>();

/**
 * Tests to see if the Babel interop import of a module results in the same thing as a Common JS
 * require of that module. Returns `null` if the module failed to load.
 *
 * We cache the result per-process.
 */
export default function isBabelInteropDefaultImportTheSame(modulePath: string): boolean | null {
    let result = cache.get(modulePath);
    if (result === undefined) {
        result = _isBabelInteropDefaultImportTheSame(modulePath);
        cache.set(modulePath, result);
    }
    return result;
}

function _isBabelInteropDefaultImportTheSame(modulePath: string): boolean | null {
    if (builtinModuleSet.has(modulePath)) {
        return true;
    }

    // We override any module that throws. (Likely because we try to require them in a
    // non-DOM environment.)
    let override = babelInteropDefaultImportOverrides.get(path.relative(CWD, modulePath));
    if (override !== undefined) return override;

    const extensionsBackup = {...require.extensions};
    const consoleLogBackup = console.log;
    const consoleWarnBackup = console.warn;
    const consoleErrorBackup = console.error;

    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};

    try {
        // Pray there are no significant global side effects. As a precaution we backup
        // `require.extensions` and reinstate it after the module was required. This cleans up after
        // modules like `@babel/register`.
        const m = require(modulePath);
        if (m && m.__esModule) {
            return m === m.default;
        } else {
            return true;
        }
    } catch (error) {
        return null;
    } finally {
        require.extensions = extensionsBackup;
        console.log = consoleLogBackup;
        console.warn = consoleWarnBackup;
        console.error = consoleErrorBackup;
    }
}
