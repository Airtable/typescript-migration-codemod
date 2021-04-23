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
        return {
            typeParameterWithVariance: mergeArrays('typeParameterWithVariance', reports),
            objectPropertyWithInternalName: mergeArrays('objectPropertyWithInternalName', reports),
            objectPropertyWithMinusVariance: mergeArrays('objectPropertyWithMinusVariance', reports),
            unsupportedTypeCast: mergeArrays('unsupportedTypeCast', reports),
        };
    }

    static logReport(report: MigrationReport) {
        {
            const locations = report.typeParameterWithVariance
                .map(location => displayLocation(location))
                .filter(location => !allowlists.typeParameterWithVariance.has(location));
            if (locations.length > 0) {
                console.log();
                console.log('Type parameter with variance:');
                for (const location of locations) {
                    console.log(`• ${location}`);
                }
            }
        }
        {
            const locations = report.objectPropertyWithInternalName
                .map(location => displayLocation(location));
            if (locations.length > 0) {
                console.log();
                console.log('Object property with an internal name:');
                for (const location of locations) {
                    console.log(`• ${location}`);
                }
            }
        }
        {
            const locations = report.objectPropertyWithMinusVariance
                .map(location => displayLocation(location));
            if (locations.length > 0) {
                console.log();
                console.log('Object property with negative variance:');
                for (const location of locations) {
                    console.log(`• ${location}`);
                }
            }
        }
        {
            const locations = report.unsupportedTypeCast
                .map(location => displayLocation(location));
            if (locations.length > 0) {
                console.log();
                console.log('Unsupported type cast:');
                for (const location of locations) {
                    console.log(`• ${location}`);
                }
            }
        }
    }

    private readonly _typeParameterWithVariance: Array<Location> = [];
    private readonly _objectPropertyWithInternalName: Array<Location> = [];
    private readonly _objectPropertyWithMinusVariance: Array<Location> = [];
    private readonly _unsupportedTypeCast: Array<Location> = [];

    typeParameterWithVariance(filePath: string, {start, end}: t.SourceLocation) {
        this._typeParameterWithVariance.push({filePath, start, end});
    }

    objectPropertyWithInternalName(filePath: string, {start, end}: t.SourceLocation) {
        this._objectPropertyWithInternalName.push({filePath, start, end});
    }

    objectPropertyWithMinusVariance(filePath: string, {start, end}: t.SourceLocation) {
        this._objectPropertyWithMinusVariance.push({filePath, start, end});
    }

    unsupportedTypeCast(filePath: string, {start, end}: t.SourceLocation) {
        this._unsupportedTypeCast.push({filePath, start, end});
    }

    generateReport(): MigrationReport {
        return {
            typeParameterWithVariance: this._typeParameterWithVariance,
            objectPropertyWithInternalName: this._objectPropertyWithInternalName,
            objectPropertyWithMinusVariance: this._objectPropertyWithMinusVariance,
            unsupportedTypeCast: this._unsupportedTypeCast,
        };
    }
}

/**
 * A report on the activities of our migration.
 */
export type MigrationReport = {
    typeParameterWithVariance: Array<Location>,
    objectPropertyWithInternalName: Array<Location>,
    objectPropertyWithMinusVariance: Array<Location>,
    unsupportedTypeCast: Array<Location>,
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
