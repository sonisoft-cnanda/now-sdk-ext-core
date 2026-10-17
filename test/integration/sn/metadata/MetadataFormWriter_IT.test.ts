import { describe, it } from '@jest/globals';
import { runLifecycle } from './lifecycle.mjs';

// Explicit opt-in. run-live.mjs owns the alias lock and post-run audit.
const live = process.env.METADATA_LIVE_ALIAS === 'dev206299' ? describe : describe.skip;
live('NSE-14 built metadata lifecycle', () => {
    it('passes L0-L6 on the named non-production alias', async () => {
        await runLifecycle();
    }, 900000);
});
