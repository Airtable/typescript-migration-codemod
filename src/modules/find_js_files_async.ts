import path from 'path';
import cp from 'child_process';

/**
 * Finds _all_ the JavaScript files in the provided directory using `git` so that we respect the
 * project’s `.gitignore`.
 */
export default function findJsFilesAsync(rootDirectory: string): Promise<Array<string>> {
    return new Promise<Array<string>>((resolve, reject) => {
        // We need to use `cp.spawn` and stream the file paths instead of `cp.exec` which builds a
        // large buffer with the entire result since `cp.exec` exceeds the default Node.js buffer
        // limits. We could increase the limits on `cp.exec`, or we could do stream processing
        // with `cp.spawn`.
        const subprocess = cp.spawn(
            'git',
            ['ls-files'],
            {cwd: rootDirectory},
        );

        let chunkLineBuffer = '';
        const filePaths: Array<string> = [];

        subprocess.stdout.on('data', (chunk: Buffer) => {
            const chunkLines = chunk.toString('utf8').split('\n');

            // Iterate through all of the lines in the chunk EXCEPT for the last one. The last
            // part we will buffer for the next message.
            for (let i = 0; i < chunkLines.length - 1; i++) {
                // Add our previous buffer if this is the first file path in the data.
                let chunkLine;
                if (i === 0) {
                    chunkLine = chunkLineBuffer + chunkLines[i];
                    chunkLineBuffer = '';
                } else {
                    chunkLine = chunkLines[i];
                }

                // Only add the file path if it is a JS file.
                if (chunkLine.endsWith('.js')) {
                    filePaths.push(path.join(rootDirectory, chunkLine));
                }
            }

            // Store the last part of the message in a buffer for next time...
            chunkLineBuffer = chunkLines[chunkLines.length - 1];
        });

        subprocess.stdout.on('end', () => {
            if (chunkLineBuffer !== '') {
                reject(new Error(`Expected stdout to end with a new line, not: "${chunkLineBuffer}"`));
                return;
            }
            resolve(filePaths);
        });
    });
}
