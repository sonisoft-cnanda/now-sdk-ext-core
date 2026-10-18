import { describe, it, expect } from '@jest/globals';
import {spawn} from 'node:child_process';

// Jest discovers the spec, but never imports the credential shim or SDK lifecycle.
// The native launcher owns both the alias lock and the independent post-lock audit.
const live = process.env.METADATA_LIVE_ALIAS === 'dev206299' ? describe : describe.skip;
live('NSE-14 built metadata lifecycle', () => {
    it('passes L0-L6 on the named non-production alias', async () => {
        const code = await new Promise<number>((resolve, reject) => {
            const child = spawn(process.execPath, ['test/integration/sn/metadata/run-live.mjs',
                '--access-helper', process.env.METADATA_ACCESS_HELPER ?? '',
                '--private-dir', process.env.METADATA_PRIVATE_DIR ?? ''], {stdio:'inherit'});
            child.on('error', reject);
            child.on('close', (status, signal) => resolve(signal ? 1 : status ?? 1));
        });
        expect(code).toBe(0);
    }, 1800000);
});
