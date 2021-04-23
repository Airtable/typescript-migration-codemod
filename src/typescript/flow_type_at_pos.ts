import path from 'path';
import childProcess from 'child_process';
import chalk from 'chalk';
import * as t from '@babel/types';
import {parse} from '@babel/parser';
import {SOURCE} from '../paths';

/**
 * Runs Flow to get the inferred type at a given position. Uses the Flow server so once the Flow
 * server is running this should be pretty fast. We use this to add explicit annotations where Flow
 * needs some help.
 *
 * Queued so that we don’t overload the Flow server.
 */
export default function flowTypeAtPos(
    filePath: string,
    location: t.SourceLocation,
): Promise<t.FlowType | null> {
    let resolve: (value: string) => void;
    let reject: (error: unknown) => void;

    const promise = new Promise<string>((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });

    flowTypeAtPosQueue.push({
        filePath,
        location,
        resolve: resolve!,
        reject: reject!,
    });

    if (processingFlowTypeAtPosQueue === false) {
        processFlowTypeAtPosQueue();
    }

    return promise.then(processFlowTypeAtPosStdout);
}

/**
 * Are we currently processing `flowTypeAtPosQueue`? If so then don’t call
 * `processFlowTypeAtPosQueue()` a second time.
 */
let processingFlowTypeAtPosQueue = false;

/**
 * Holds all the pending `flowTypeAtPos()` calls.
 */
const flowTypeAtPosQueue: Array<{
    filePath: string,
    location: t.SourceLocation,
    resolve: (value: string) => void,
    reject: (error: unknown) => void,
}> = [];

/**
 * Continually process all the entries in `flowTypeAtPosQueue`.
 */
function processFlowTypeAtPosQueue() {
    processingFlowTypeAtPosQueue = true;

    const entry = flowTypeAtPosQueue.shift();

    if (!entry) {
        processingFlowTypeAtPosQueue = false;
        return;
    }

    executeFlowTypeAtPos(entry.filePath, entry.location).then(
        value => {
            // Start the next asynchronous `flow type-at-pos` request before resolving the entry!
            // When we resolve the entry some synchronous work will be done to parse the result.
            // We can do that work concurrently while `flow type-at-pos` works.
            processFlowTypeAtPosQueue();
            entry.resolve(value);
        },
        value => {
            processFlowTypeAtPosQueue();
            entry.reject(value);
        },
    );
}

/**
 * Actually executes `flow type-at-pos`. This will be called behind a throttle.
 */
async function executeFlowTypeAtPos(
    filePath: string,
    location: t.SourceLocation,
): Promise<string> {
    const {line, column} = location.start;
    const command = `$(yarn bin)/flow type-at-pos "${filePath}" ${line} ${column + 1} --no-auto-start`;

    const relativeFilePath = path.relative(SOURCE, filePath);
    console.log(chalk.dim(
        'flow type-at-pos ' +
            (/[^./_a-zA-Z0-9]/.test(relativeFilePath) ? `"${relativeFilePath}"` : relativeFilePath) +
            ` ${line} ${column + 1}`
    ));

    // Actually run Flow...
    const stdout = await new Promise<string>((resolve, reject) => {
        childProcess.exec(command, (error, stdout) => {
            if (error) reject(error)
            else resolve(stdout)
        });
    });

    return stdout;
}

/**
 * Processes the standard output of `flow type-at-pos`.
 */
function processFlowTypeAtPosStdout(stdout: string): t.FlowType | null {
    // Sanitize stdout...
    const flowTypeString = stdout.split('\n', 2)[0].replace(/ \((implicit|explicit)\)$/, '');

    // Flow does not know the type at this location.
    if (flowTypeString === '(unknown)') return null;

    // The inferred Flow type is really big, a human probably would not have written it. Don’t
    // return the type.
    if (flowTypeString.length >= 100) return null;

    // Parse the Flow type and return it!
    const flowType = parse(`type T = ${flowTypeString}`, {plugins: ['flow']});
    return (flowType.program.body[0] as t.TypeAlias).right;
}
