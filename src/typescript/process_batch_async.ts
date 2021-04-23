import fs from 'fs-extra';
import * as t from '@babel/types';
import * as recast from 'recast';
import * as recastFlowParser from 'recast/parsers/flow';
import recastOptions from '../recast_options';
import migrateToTypescript from './migrate_to_typescript';
import MigrationReporter from './migration_reporter';

export default async function processBatchAsync(
    reporter: MigrationReporter,
    filePaths: Array<string>,
) {
    await Promise.all(filePaths.map(async filePath => {
        try {
            const fileBuffer = await fs.readFile(filePath);

            const fileText = fileBuffer.toString('utf8');
            const file: t.File = recast.parse(fileText, {parser: recastFlowParser});
            const fileStats = {hasJsx: false};

            await migrateToTypescript(reporter, filePath, file, fileStats);

            // Write the migrated file to a temporary file since we’re just testing at the moment.
            const newFileTextWithFlowComment = recast.print(file, recastOptions).code;
            const newFileText = newFileTextWithFlowComment
                .replace(/\/\/ @flow.*\n+/, '')
                .replace(/\/\/ flow-disable-next-line/g, '// @ts-ignore');
            const tsFilePath = filePath.replace(/\.js$/, fileStats.hasJsx ? '.tsx' : '.ts');
            await fs.writeFile(tsFilePath, newFileText);
        } catch (error) {
            // Report errors, but don’t crash the worker...
            console.error(error);
        }
    }));
}
