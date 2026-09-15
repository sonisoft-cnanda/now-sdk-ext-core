import {describe, expect, it} from '@jest/globals';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

import {DEFAULT_SN_INSTANCE_ALIAS, SN_INSTANCE_ALIAS} from '../../test_utils/test_config';

const here = fileURLToPath(new URL('.', import.meta.url));
const testRoot = join(here, '../..');

function walk(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) files.push(...walk(path));
        else if (path.endsWith('.ts')) files.push(path);
    }
    return files;
}

describe('live-test instance alias', () => {
    it('defaults to the current PDI and stays overridable from one constant', () => {
        expect(DEFAULT_SN_INSTANCE_ALIAS).toMatch(/^\S+$/);
        expect(DEFAULT_SN_INSTANCE_ALIAS.startsWith('<')).toBe(false);
        expect(SN_INSTANCE_ALIAS).toBe(process.env.SN_INSTANCE_ALIAS?.trim() || DEFAULT_SN_INSTANCE_ALIAS);
    });

    it('does not embed the live alias in session or credential calls', () => {
        const offenders: string[] = [];
        const liveLiteral = new RegExp(
            String.raw`(?:createBrowserSession\(\s*\{\s*alias:|getCredentials\()\s*['"\`]${DEFAULT_SN_INSTANCE_ALIAS}['"\`]`,
        );
        for (const file of walk(testRoot)) {
            const rel = relative(testRoot, file).replaceAll('\\', '/');
            if (rel === 'test_utils/test_config.ts') continue;
            if (liveLiteral.test(readFileSync(file, 'utf8'))) offenders.push(rel);
        }
        expect(offenders).toEqual([]);
    });
});
