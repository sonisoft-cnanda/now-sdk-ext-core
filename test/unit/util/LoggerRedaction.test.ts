/**
 * End-to-end regression test for NEX-53.
 *
 * The unit tests in redact.test.ts prove the redaction function works. This proves
 * the thing that actually broke: that a secret handed to Logger does not reach
 * logs/*.log on disk. Redaction is wired in as a Winston format, and a format can be
 * silently bypassed by ordering, by the splat symbol, or by a transport that
 * re-serializes from the raw meta — none of which a unit test on the function would
 * catch.
 *
 * Writes to the real logs/ directory, which is gitignored and is where the code under
 * test writes by design (Logger's file transports are hard-coded relative paths).
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../../src/util/Logger';

const DEBUG_LOG = path.resolve(process.cwd(), 'logs/app-debug.log');
const ERROR_LOG = path.resolve(process.cwd(), 'logs/app-error.log');

/** Unique per run, so a stale line from an earlier build cannot mask a regression. */
const RUN = `${Date.now()}`;
const SECRET_TOKEN = `LEAKED-USER-TOKEN-${RUN}`;
const SECRET_COOKIE = `LEAKED-COOKIE-${RUN}`;
const SECRET_PASSWORD = `LEAKED-PASSWORD-${RUN}`;
const HARMLESS_PATH = `/api/now/table/incident_${RUN}`;

/** Winston file transports flush asynchronously; poll rather than guess a delay. */
async function waitForLogContaining(file: string, needle: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(file)) {
            const contents = fs.readFileSync(file, 'utf8');
            if (contents.includes(needle)) {
                return contents;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for "${needle}" in ${file}`);
}

describe('Logger redaction (end to end, on disk)', () => {
    let debugContents: string;
    let errorContents: string;

    beforeAll(async () => {
        const logger = new Logger('RedactionTest', 'debug');

        // Exactly the shape RequestHandler.getRequestConfig builds and then logs.
        logger.debug('Retrieved Configuration', {
            config: {
                auth: {
                    instanceUrl: 'https://dev.service-now.com',
                    type: 'basic',
                    userToken: SECRET_TOKEN,
                    cookie: SECRET_COOKIE,
                },
                method: 'GET',
                path: HARMLESS_PATH,
            },
        });

        const err: any = new Error(`request failed ${RUN}`);
        err.config = { auth: { password: SECRET_PASSWORD } };
        logger.error('Error during request.', { error: err, request: { path: HARMLESS_PATH } });

        debugContents = await waitForLogContaining(DEBUG_LOG, HARMLESS_PATH);
        errorContents = await waitForLogContaining(ERROR_LOG, `request failed ${RUN}`);
    });

    it('does not write a session token to the debug log', () => {
        expect(debugContents).not.toContain(SECRET_TOKEN);
    });

    it('does not write a session cookie to the debug log', () => {
        expect(debugContents).not.toContain(SECRET_COOKIE);
    });

    it('does not write a password carried on a thrown error to the error log', () => {
        expect(errorContents).not.toContain(SECRET_PASSWORD);
    });

    it('still records the non-secret context, or the logs stop being useful', () => {
        expect(debugContents).toContain(HARMLESS_PATH);
        expect(debugContents).toContain('Retrieved Configuration');
        expect(errorContents).toContain(`request failed ${RUN}`);
    });
});
