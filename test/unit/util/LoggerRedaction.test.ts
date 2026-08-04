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
 * Opts into file logging explicitly and points it at a temp directory. It used to write
 * to a relative ./logs/ because that was the only thing Logger could do; since NEX-3
 * that is off by default and configurable, so a test that needs files has to say so.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../../../src/util/Logger';
import {
    configureLogging,
    getLogConfig,
    flushLogs,
    resetLoggingForTests,
} from '../../../src/util/LogConfig';

let tmpRoot: string;
let logFile: string;

/** Unique per run, so a stale line from an earlier build cannot mask a regression. */
const RUN = `${Date.now()}`;
const SECRET_TOKEN = `LEAKED-USER-TOKEN-${RUN}`;
const SECRET_COOKIE = `LEAKED-COOKIE-${RUN}`;
const SECRET_PASSWORD = `LEAKED-PASSWORD-${RUN}`;
const SECRET_IN_MESSAGE = `LEAKEDVIAMESSAGE${RUN}`;
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
    let contents: string;

    afterAll(async () => {
        await flushLogs();
        resetLoggingForTests();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    beforeAll(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-redaction-'));
        configureLogging({ file: true, dir: tmpRoot, level: 'debug' });
        logFile = path.join(getLogConfig().dir, 'nex.log');

        const logger = new Logger('RedactionTest');

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

        // The other half of NEX-3, and the half a metadata format cannot reach: the
        // secret is already text by the time the format runs. This is verbatim the
        // shape ScriptTracer used to log at INFO on every trace.
        logger.debug(`Session ID from debugger/start: ${SECRET_IN_MESSAGE}`);

        const err: any = new Error(`request failed ${RUN}`);
        err.config = { auth: { password: SECRET_PASSWORD } };
        logger.error('Error during request.', { error: err, request: { path: HARMLESS_PATH } });

        // One file now, not four: the level-split files were redundant (combined.log
        // was a superset) and app-info.log excluded every warning.
        contents = await waitForLogContaining(logFile, `request failed ${RUN}`);
    });

    it('does not write a session token to the log', () => {
        expect(contents).not.toContain(SECRET_TOKEN);
    });

    it('does not write a session cookie to the log', () => {
        expect(contents).not.toContain(SECRET_COOKIE);
    });

    it('does not write a secret interpolated into the message string', () => {
        expect(contents).not.toContain(SECRET_IN_MESSAGE);
        // and still says what happened
        expect(contents).toContain('Session ID from debugger/start');
    });

    it('does not write a password carried on a thrown error', () => {
        expect(contents).not.toContain(SECRET_PASSWORD);
    });

    it('still records the non-secret context, or the logs stop being useful', () => {
        expect(contents).toContain(HARMLESS_PATH);
        expect(contents).toContain('Retrieved Configuration');
        expect(contents).toContain(`request failed ${RUN}`);
    });
});
