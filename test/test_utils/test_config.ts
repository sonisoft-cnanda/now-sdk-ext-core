import 'dotenv/config';

/**
 * Default live-test alias. Change it here — not in individual tests — or override
 * with `SN_INSTANCE_ALIAS` in the environment or a local `.env`.
 *
 *   SN_INSTANCE_ALIAS=strongtiedev npm run test:integration
 */
export const DEFAULT_SN_INSTANCE_ALIAS = 'dev206299';

/**
 * ServiceNow instance alias used for every live test.
 * Tests must import this constant instead of embedding an instance name.
 */
export const SN_INSTANCE_ALIAS: string =
    process.env.SN_INSTANCE_ALIAS?.trim() || DEFAULT_SN_INSTANCE_ALIAS;
