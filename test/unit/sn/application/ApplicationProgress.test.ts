import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ApplicationManager } from '../../../../src/sn/application/ApplicationManager';
import { AppRepoApplication } from '../../../../src/sn/application/AppRepoApplication';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import type { OperationProgress } from '../../../../src/sn/OperationProgress';

/**
 * Proves the callback reaches the PRIVATE poll loops in these two classes.
 *
 * The emitter has its own tests, but a parameter threaded through a public
 * method and never forwarded to the private wait would type-check and pass all
 * of them. ATFTestExecutor is covered separately because its wait is public;
 * these two are only reachable through their *AndWait entry points.
 */
describe('application progress reporting', () => {
    const instance = new ServiceNowInstance({ alias: 'dev' });

    beforeEach(() => {
        // Collapse the poll interval so the loop runs without wall-clock waits.
        jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
            fn();
            return 0 as unknown as NodeJS.Timeout;
        }) as never);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    /** Feeds a fixed tracker sequence, repeating the last entry once exhausted. */
    function sequence(steps: Array<Record<string, unknown>>) {
        let i = 0;
        return () => {
            const step = steps[Math.min(i, steps.length - 1)];
            i += 1;
            return Promise.resolve(step);
        };
    }

    describe('ApplicationManager.installStoreApplicationAndWait', () => {
        it('reports progress from inside the poll loop', async () => {
            const mgr = new ApplicationManager(instance);
            jest.spyOn(mgr, 'installStoreApplication').mockResolvedValue({
                tracker_id: 'TRACK1',
            } as never);

            // ProgressWorker is constructed inside the private wait, so stub its prototype.
            const { ProgressWorker } = await import('../../../../src/sn/ProgressWorker');
            jest.spyOn(ProgressWorker.prototype, 'getProgress').mockImplementation(
                sequence([
                    { percent_complete: 0, status: '2', status_message: 'Queued' },
                    { percent_complete: 70, status: '2', status_message: 'Installing' },
                    { percent_complete: 100, status: '2', status_message: 'Installed' },
                ]) as never,
            );

            const seen: OperationProgress[] = [];
            await mgr.installStoreApplicationAndWait(
                { appId: 'app', version: '1.0.0' } as never,
                1,
                60_000,
                (p) => seen.push(p),
            );

            expect(seen.map((p) => p.percentComplete)).toEqual([0, 70, 100]);
            expect(seen.map((p) => p.message)).toEqual(['Queued', 'Installing', 'Installed']);
        });

        it('is unchanged when no callback is supplied', async () => {
            const mgr = new ApplicationManager(instance);
            jest.spyOn(mgr, 'installStoreApplication').mockResolvedValue({
                tracker_id: 'TRACK1',
            } as never);
            const { ProgressWorker } = await import('../../../../src/sn/ProgressWorker');
            jest.spyOn(ProgressWorker.prototype, 'getProgress').mockResolvedValue({
                percent_complete: 100,
                status: '2',
                status_message: 'Installed',
            } as never);

            await expect(
                mgr.installStoreApplicationAndWait({ appId: 'app', version: '1.0.0' } as never, 1, 60_000),
            ).resolves.toBeDefined();
        });
    });

    describe('AppRepoApplication.installFromAppRepoAndWait', () => {
        it('reports progress from inside the poll loop', async () => {
            const repo = new AppRepoApplication(instance);
            jest.spyOn(repo, 'installFromAppRepo').mockResolvedValue({
                links: { progress: { id: 'PROG1' } },
            } as never);
            jest.spyOn(repo as never, 'getProgress').mockImplementation(
                sequence([
                    { percent_complete: 10, status: '2', status_message: 'Starting' },
                    { percent_complete: 100, status: '2', status_message: 'Complete' },
                ]) as never,
            );

            const seen: OperationProgress[] = [];
            await repo.installFromAppRepoAndWait({ scope: 'x_app' } as never, 1, 60_000, (p) =>
                seen.push(p),
            );

            expect(seen.map((p) => p.percentComplete)).toEqual([10, 100]);
        });

        it('suppresses an unchanged tick', async () => {
            const repo = new AppRepoApplication(instance);
            jest.spyOn(repo, 'installFromAppRepo').mockResolvedValue({
                links: { progress: { id: 'PROG1' } },
            } as never);
            jest.spyOn(repo as never, 'getProgress').mockImplementation(
                sequence([
                    { percent_complete: 40, status: '2', status_message: 'Working' },
                    { percent_complete: 40, status: '2', status_message: 'Working' },
                    { percent_complete: 100, status: '2', status_message: 'Done' },
                ]) as never,
            );

            const seen: OperationProgress[] = [];
            await repo.installFromAppRepoAndWait({ scope: 'x_app' } as never, 1, 60_000, (p) =>
                seen.push(p),
            );

            expect(seen.map((p) => p.percentComplete)).toEqual([40, 100]);
        });
    });

    it('does not let a throwing consumer callback abort the operation', async () => {
        // Progress reporting is best-effort. A flaky sink must not take down a
        // thirty-minute install that had already succeeded.
        const repo = new AppRepoApplication(instance);
        jest.spyOn(repo, 'installFromAppRepo').mockResolvedValue({
            links: { progress: { id: 'PROG1' } },
        } as never);
        jest.spyOn(repo as never, 'getProgress').mockResolvedValue({
            percent_complete: 100,
            status: '2',
            status_message: 'Done',
        } as never);

        await expect(
            repo.installFromAppRepoAndWait({ scope: 'x_app' } as never, 1, 60_000, () => {
                throw new Error('sink exploded');
            }),
        ).resolves.toBeDefined();
    });
});
