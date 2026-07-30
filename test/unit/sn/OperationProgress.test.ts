import { describe, it, expect, jest } from '@jest/globals';
import {
    createProgressEmitter,
    OperationProgress,
} from '../../../src/sn/OperationProgress';

describe('createProgressEmitter', () => {
    it('returns a callable no-op when no callback is supplied', () => {
        const emit = createProgressEmitter(undefined);
        expect(() => emit({ message: 'anything' })).not.toThrow();
    });

    it('forwards the first update', () => {
        const seen: OperationProgress[] = [];
        const emit = createProgressEmitter((p) => seen.push(p));

        emit({ message: 'Installing', percentComplete: 0, status: '1' });

        expect(seen).toEqual([{ message: 'Installing', percentComplete: 0, status: '1' }]);
    });

    // The poll loops tick every 5s by default. Over a 30-minute install that is
    // 360 ticks, nearly all identical — forwarding each would bury the handful
    // that mean something.
    it('suppresses identical consecutive updates', () => {
        const seen: OperationProgress[] = [];
        const emit = createProgressEmitter((p) => seen.push(p));

        const same = { message: 'Installing', percentComplete: 40, status: '2' };
        emit(same);
        emit({ ...same });
        emit({ ...same });

        expect(seen).toHaveLength(1);
    });

    it('forwards again when the percentage moves', () => {
        const seen: OperationProgress[] = [];
        const emit = createProgressEmitter((p) => seen.push(p));

        emit({ message: 'Installing', percentComplete: 40, status: '2' });
        emit({ message: 'Installing', percentComplete: 60, status: '2' });

        expect(seen.map((p) => p.percentComplete)).toEqual([40, 60]);
    });

    it('forwards again when only the message moves', () => {
        // Percentage can sit still across a meaningful state change.
        const seen: OperationProgress[] = [];
        const emit = createProgressEmitter((p) => seen.push(p));

        emit({ message: 'Downloading', percentComplete: 50, status: '2' });
        emit({ message: 'Applying', percentComplete: 50, status: '2' });

        expect(seen.map((p) => p.message)).toEqual(['Downloading', 'Applying']);
    });

    it('forwards again when only the status moves', () => {
        const seen: OperationProgress[] = [];
        const emit = createProgressEmitter((p) => seen.push(p));

        emit({ message: 'Working', percentComplete: 100, status: '2' });
        emit({ message: 'Working', percentComplete: 100, status: '3' });

        expect(seen.map((p) => p.status)).toEqual(['2', '3']);
    });

    it('treats an absent percentage as distinct from zero', () => {
        // A consumer rendering a bar has to tell "no information" from "not started".
        const seen: OperationProgress[] = [];
        const emit = createProgressEmitter((p) => seen.push(p));

        emit({ message: 'Working' });
        emit({ message: 'Working', percentComplete: 0 });

        expect(seen).toHaveLength(2);
    });

    it('re-forwards a value that returns after changing', () => {
        // Dedupe is against the PREVIOUS update only, not a set of everything seen.
        const seen: OperationProgress[] = [];
        const emit = createProgressEmitter((p) => seen.push(p));

        emit({ message: 'a', percentComplete: 10 });
        emit({ message: 'b', percentComplete: 20 });
        emit({ message: 'a', percentComplete: 10 });

        expect(seen).toHaveLength(3);
    });

    it('does not invoke the callback at all when nothing is reported', () => {
        const cb = jest.fn();
        createProgressEmitter(cb as never);
        expect(cb).not.toHaveBeenCalled();
    });
});
