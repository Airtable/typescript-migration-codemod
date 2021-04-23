import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import cluster from 'cluster';
import {SOURCE, CWD} from '../paths';
import findFlowFilesAsync from './find_flow_files_async';
import MigrationReporter from './migration_reporter';
import processBatchAsync from './process_batch_async';
import {MigrationReport} from './migration_reporter';

/** The number of CPUs our computer has. */
const CPUS = os.cpus().length;

/** The size of a file batch that we send to a worker. */
const BATCH = 50;

async function runPrimaryAsync() {
    const flowFilePaths = await findFlowFilesAsync(SOURCE);
    const flowFilePathsCopy = flowFilePaths.slice();

    // Shuffle the array since files near each other in the folder hierarchy have similar
    // workloads and we want to evenly spread workloads out among workers.
    shuffle(flowFilePaths);

    function popBatch(): Array<string> | null {
        if (flowFilePaths.length === 0) return null;

        const batchSize = Math.min(BATCH, flowFilePaths.length);
        const batch: Array<string> = [];

        for (let i = 0; i < batchSize; i++) {
            batch.push(flowFilePaths.pop()!);
        }

        return batch;
    }

    const workerCount = CPUS;
    console.log(`Spawning ${workerCount} workers to process ${flowFilePaths.length} files`);

    const reports: Array<MigrationReport> = [];

    // Spawns a worker for every CPU on our machine to maximize parallelization.
    //
    // Lifetime of a worker:
    //
    // 1. Primary sends a batch to worker.
    // 2. Worker process batch and sends back a `next` message.
    // 3. Primary sends worker a new batch.
    // 4. When primary runs out of batches, instead of sending a batch it sends a `report` message.
    // 5. The worker responds with a report of its activities.
    // 6. Primary kills the worker.
    for (let i = 0; i < CPUS; i++) {
        const initialBatch = popBatch();
        if (initialBatch === null) break; // Stop spawning workers if we have no more batches!

        let timeoutId: NodeJS.Timeout | null = null;

        const worker = cluster.fork();
        sendBatch(initialBatch);

        worker.on('message', message => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }

            switch (message.type) {
                // Either send the worker a new batch or ask the worker to send us a report of
                // its activities.
                case 'next': {
                    const nextBatch = popBatch();
                    if (nextBatch !== null) {
                        sendBatch(nextBatch);
                    } else {
                        worker.send({type: 'report'});
                    }
                    break;
                }

                // Once we get the worker’s final report, kill the worker.
                case 'report': {
                    reports.push(message.report);
                    worker.kill();
                    if (reports.length === workerCount) {
                        finish();
                    }
                    break;
                }
            }
        });

        function sendBatch(batch: Array<string>) {
            console.log(`Sending ${batch.length} files to worker #${i + 1}`);
            worker.send({type: 'batch', batch});

            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }

            timeoutId = setTimeout(() => {
                console.log(`Worker #${i + 1} hasn’t responded in 2 minutes after sending the batch:`);
                for (const filePath of batch) {
                    console.log(`• ${path.relative(CWD, filePath)}`);
                }
            }, 2 * 60 * 1000);
        }
    }

    // Before the primary process exits, merge the reports of all our workers and log it to the
    // console for debugging.

    async function finish() {
        console.log('Deleting all the old files.');
        for (const flowFilePath of flowFilePathsCopy) {
            await fs.remove(flowFilePath);
        }

        console.log(`Merging reports from ${reports.length} workers.`);
        const mergedReport = MigrationReporter.mergeReports(reports);
        MigrationReporter.logReport(mergedReport);
    }
}

async function runWorkerAsync() {
    const reporter = new MigrationReporter();

    process.on('message', message => {
        switch (message.type) {
            // Process a batch of files and ask for more...
            case 'batch': {
                processBatchAsync(reporter, message.batch).then(
                    () => process.send!({type: 'next'}),
                    error => {
                        console.error(error);
                        process.exit(1);
                    },
                );
                break;
            }

            // We were asked for a report, so send one back!
            case 'report': {
                process.send!({
                    type: 'report',
                    report: reporter.generateReport(),
                });
                break;
            }
        }
    });
}

if (cluster.isMaster) {
    runPrimaryAsync().catch(error => {
        console.error(error);
        process.exit(1);
    });
} else {
    runWorkerAsync().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

/**
 * Randomize the order of an array.
 */
function shuffle<T>(a: Array<T>) {
    let j, x, i;
    for (i = a.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        x = a[i];
        a[i] = a[j];
        a[j] = x;
    }
    return a;
}
