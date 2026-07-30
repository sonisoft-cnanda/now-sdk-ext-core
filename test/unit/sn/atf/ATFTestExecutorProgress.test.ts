import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ATFTestExecutor } from '../../../../src/sn/atf/ATFTestExecutor';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import type { OperationProgress } from '../../../../src/sn/OperationProgress';

/**
 * Verifies the callback actually fires FROM THE POLL LOOP, not merely that the
 * emitter dedupes in isolation. The wiring is the part that can be wrong: a
 * parameter threaded through the public method but never reaching the private
 * wait would type-check and pass every emitter test.
 *
 * `waitForTestSuiteCompletion` is public, so it can be driven directly with a
 * stubbed progress source and no network.
 */
describe('ATFTestExecutor progress reporting', () => {
    let executor: ATFTestExecutor;

    beforeEach(() => {
        executor = new ATFTestExecutor(new ServiceNowInstance({ alias: 'dev' }));
        // Collapse the poll interval so the loop runs without wall-clock waits.
        jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
            fn();
            return 0 as unknown as NodeJS.Timeout;
        }) as never);
    });

    afterEach(() => {
        // Explicit rather than relying on jest's per-file isolation; the repo has
        // no restoreMocks setting, and a global setTimeout stub left in place is
        // the kind of thing that only bites once the file grows.
        jest.restoreAllMocks();
    });

    /** Drives getTestSuiteProgress through a fixed sequence, then results. */
    function stubProgress(sequence: Array<Record<string, unknown>>): void {
        let i = 0;
        jest.spyOn(executor as never, 'getTestSuiteProgress').mockImplementation((() => {
            const step = sequence[Math.min(i, sequence.length - 1)];
            i += 1;
            return Promise.resolve(step);
        }) as never);
        jest.spyOn(executor as never, 'getTestSuiteResults').mockResolvedValue({ ok: true } as never);
    }

    it('reports progress as the suite advances', async () => {
        stubProgress([
            { percent_complete: 0, status: '2', status_message: 'Queued', links: {} },
            { percent_complete: 50, status: '2', status_message: 'Running', links: {} },
            {
                percent_complete: 100,
                status: '2',
                status_message: 'Complete',
                links: { results: { id: 'RESULT1' } },
            },
        ]);

        const seen: OperationProgress[] = [];
        await executor.waitForTestSuiteCompletion('PROGRESS1', 1, (p) => seen.push(p));

        expect(seen.map((p) => p.percentComplete)).toEqual([0, 50, 100]);
        expect(seen.map((p) => p.message)).toEqual(['Queued', 'Running', 'Complete']);
    });

    it('does not repeat an unchanged tick', async () => {
        stubProgress([
            { percent_complete: 25, status: '2', status_message: 'Running', links: {} },
            { percent_complete: 25, status: '2', status_message: 'Running', links: {} },
            {
                percent_complete: 100,
                status: '2',
                status_message: 'Complete',
                links: { results: { id: 'RESULT1' } },
            },
        ]);

        const seen: OperationProgress[] = [];
        await executor.waitForTestSuiteCompletion('PROGRESS1', 1, (p) => seen.push(p));

        expect(seen.map((p) => p.percentComplete)).toEqual([25, 100]);
    });

    it('behaves exactly as before when no callback is supplied', async () => {
        stubProgress([
            { percent_complete: 100, status: '2', status_message: 'Done', links: { results: { id: 'R' } } },
        ]);

        await expect(executor.waitForTestSuiteCompletion('PROGRESS1', 1)).resolves.toEqual({ ok: true });
    });
});
