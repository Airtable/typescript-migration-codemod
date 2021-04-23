import fs from 'fs-extra';
import * as t from '@babel/types';
import * as recast from 'recast';
import * as recastFlowParser from 'recast/parsers/flow';
import recastOptions from '../recast_options';
import migrateToEsModules from './migrate_to_es_modules';
import MigrationReporter from './migration_reporter';

export default async function processBatchAsync(
    reporter: MigrationReporter,
    filePaths: Array<string>,
) {
    await Promise.all(filePaths.map(async filePath => {
        const fileBuffer = await fs.readFile(filePath);

        // Skip files that are greater than 1mb.
        if (fileBuffer.byteLength > 1000000) {
            reporter.skippedLargeFile(filePath);
            return;
        }

        const fileText = fileBuffer.toString('utf8');
        const file: t.File = recast.parse(fileText, {parser: recastFlowParser});

        migrateToEsModules(reporter, filePath, file);

        // Write the migrated file to a temporary file since we’re just testing at the moment.
        const newFileText = recast.print(file, recastOptions).code;
        const tmpFilePath = filePath; // .replace(/\.js$/, '.tmp.js');
        await fs.writeFile(tmpFilePath, newFileText);
    }));
}
