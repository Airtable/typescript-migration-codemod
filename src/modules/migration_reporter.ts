import path from 'path';
import * as t from '@babel/types';
import {CWD} from '../paths';
import * as allowlists from './allowlists';

/**
 * A location that also includes the file path.
 */
interface Location extends t.SourceLocation {
    filePath: string,
}

/**
 * Collects information during the migration and generates a report at the very end. We will have
 * a separate instance for each worker and we’ll merge them together at the end.
 */
class MigrationReporter {
    static mergeReports(reports: Array<MigrationReport>): MigrationReport {
        const requireWasDestructed = new Map<string, number>();
        for (const report of reports) {
            for (const {modulePath, count} of report.requireWasDestructed) {
                const lastCount = requireWasDestructed.get(modulePath) || 0;
                requireWasDestructed.set(modulePath, lastCount + count);
            }
        }

        const unableToLoadExternalModule = new Set<string>();
        for (const report of reports) {
            for (const modulePath of report.unableToLoadExternalModule) {
                unableToLoadExternalModule.add(modulePath);
            }
        }

        return {
            skippedLargeFiles: mergeArrays('skippedLargeFiles', reports),
            requireNotCalled: mergeArrays('requireNotCalled', reports),
            requireOtherThanString: mergeArrays('requireOtherThanString', reports),
            cannotFindModule: mergeArrays('cannotFindModule', reports),
            moduleNotExportAssignment: mergeArrays('moduleNotExportAssignment', reports),
            requireWasDestructed: Array.from(requireWasDestructed)
                .map(([modulePath, count]) => ({modulePath, count})),
            unableToLoadExternalModule: Array.from(unableToLoadExternalModule),
            importAfterSideEffects: mergeArrays('importAfterSideEffects', reports),
        };
    }

    static logReport(report: MigrationReport) {
        {
            if (report.skippedLargeFiles.length > 0) {
                console.log();
                console.log('Skipped large files:');
                for (const filePath of report.skippedLargeFiles) {
                    console.log(`• ${path.relative(CWD, filePath)}`);
                }
            }
        }
        {
            const requireNotCalled = report.requireNotCalled
                .map(location => displayLocation(location))
                .filter(location => !allowlists.requireNotCalled.has(location));
            if (requireNotCalled.length > 0) {
                console.log();
                console.log('Require not called:');
                for (const location of requireNotCalled) {
                    console.log(`• ${location}`);
                }
            }
        }
        {
            const requireOtherThanString = report.requireOtherThanString
                .map(location => displayLocation(location))
                .filter(location => !allowlists.requireOtherThanString.has(location));
            if (requireOtherThanString.length > 0) {
                console.log();
                console.log('Required something other than a string:');
                for (const location of requireOtherThanString) {
                    console.log(`• ${location}`);
                }
            }
        }
        {
            const cannotFindModule = report.cannotFindModule
                .map(({moduleId, location}) => ({moduleId, location: displayLocation(location)}))
                .filter(({location}) => !allowlists.cannotFindModule.has(location));
            if (cannotFindModule.length > 0) {
                console.log();
                console.log('Required something other than a string:');
                for (const {moduleId, location} of cannotFindModule) {
                    console.log(`• Cannot find module '${moduleId}' in '${location}'`);
                }
            }
        }
        {
            const moduleNotExportAssignment = report.moduleNotExportAssignment
                .map(location => displayLocation(location))
                .filter(location => !allowlists.moduleNotExportAssignment.has(location));
            if (moduleNotExportAssignment.length > 0) {
                console.log();
                console.log('Module reference is not an exports assignment:');
                for (const location of moduleNotExportAssignment) {
                    console.log(`• ${location}`);
                }
            }
        }
        {
            const unableToLoadExternalModule = report.unableToLoadExternalModule;
            if (unableToLoadExternalModule.length > 0) {
                console.log();
                console.log('Unable to load external module:');
                for (const modulePath of unableToLoadExternalModule) {
                    console.log(`• ${path.relative(CWD, modulePath)}`);
                }
            }
        }

        // Not fatal, use this as a recommendation for files to manually migrate.
        //
        // {
        //     const requireWasDestructed =
        //         Array.from(report.requireWasDestructed)
        //             .filter(({count}) => count >= 10)
        //             .sort(({count: count1}, {count: count2}) => count1 > count2 ? -1 : count1 < count2 ? 1 : 0);
        //     if (requireWasDestructed.length > 0) {
        //         console.log();
        //         console.log('Requires for these modules were destructed:');
        //         for (const {modulePath, count} of requireWasDestructed) {
        //             console.log(`• Module '${path.relative(CWD, modulePath)}' was destructed ${count} time(s).`);
        //         }
        //     }
        // }

        // There are a lot of these and they are mostly harmless. If there is an error we will fail
        // fast in the module scope and should catch the issue in tests.
        //
        // {
        //     const importAfterSideEffects = report.importAfterSideEffects
        //         .map(location => displayLocation(location))
        //         .filter(location => !allowlists.importAfterSideEffects.has(location));
        //     if (importAfterSideEffects.length > 0) {
        //         console.log();
        //         console.log('Import after side effects:');
        //         for (const location of importAfterSideEffects) {
        //             console.log(`• ${location}`);
        //         }
        //     }
        // }
    }

    private readonly _skippedLargeFiles: Array<string> = [];
    private readonly _requireNotCalled: Array<Location> = [];
    private readonly _requireOtherThanString: Array<Location> = [];
    private readonly _cannotFindModule: Array<{moduleId: string, location: Location}> = [];
    private readonly _moduleNotExports: Array<Location> = [];
    private readonly _requireWasDestructed = new Map<string, number>();
    private readonly _unableToLoadExternalModule = new Set<string>();
    private readonly _importAfterSideEffects: Array<Location> = [];

    skippedLargeFile(filePath: string) {
        this._skippedLargeFiles.push(filePath);
    }

    requireNotCalled(filePath: string, {start, end}: t.SourceLocation) {
        this._requireNotCalled.push({filePath, start, end});
    }

    requireOtherThanString(filePath: string, {start, end}: t.SourceLocation) {
        this._requireOtherThanString.push({filePath, start, end});
    }

    cannotFindModule(moduleId: string, filePath: string, {start, end}: t.SourceLocation) {
        this._cannotFindModule.push({moduleId, location: {filePath, start, end}});
    }

    moduleNotExportAssignment(filePath: string, {start, end}: t.SourceLocation) {
        this._moduleNotExports.push({filePath, start, end});
    }

    requireWasDestructed(modulePath: string) {
        const count = this._requireWasDestructed.get(modulePath) || 0;
        this._requireWasDestructed.set(modulePath, count + 1);
    }

    unableToLoadExternalModule(modulePath: string) {
        this._unableToLoadExternalModule.add(modulePath);
    }

    importAfterSideEffects(filePath: string, {start, end}: t.SourceLocation) {
        this._importAfterSideEffects.push({filePath, start, end});
    }

    generateReport(): MigrationReport {
        return {
            skippedLargeFiles: this._skippedLargeFiles,
            requireNotCalled: this._requireNotCalled,
            requireOtherThanString: this._requireOtherThanString,
            cannotFindModule: this._cannotFindModule,
            moduleNotExportAssignment: this._moduleNotExports,
            requireWasDestructed: Array.from(this._requireWasDestructed)
                .map(([modulePath, count]) => ({modulePath, count})),
            unableToLoadExternalModule: Array.from(this._unableToLoadExternalModule),
            importAfterSideEffects: this._importAfterSideEffects,
        };
    }
}

/**
 * A report on the activities of our migration.
 */
export type MigrationReport = {
    skippedLargeFiles: Array<string>,
    requireNotCalled: Array<Location>,
    requireOtherThanString: Array<Location>,
    cannotFindModule: Array<{moduleId: string, location: Location}>,
    moduleNotExportAssignment: Array<Location>,
    requireWasDestructed: Array<{modulePath: string, count: number}>,
    unableToLoadExternalModule: Array<string>,
    importAfterSideEffects: Array<Location>,
};

export default MigrationReporter;

function displayLocation({filePath, start}: Location): string {
    return `${path.relative(CWD, filePath)}:${start.line}:${start.column}`;
}

function mergeArrays<T>(
    k: keyof MigrationReport,
    os: Array<MigrationReport>,
): Array<T> {
    const a: Array<T> = [];
    for (const o of os) for (const x of o[k]) a.push(x as any); // Laziness. Could probably make this type safe.
    return a;
}
