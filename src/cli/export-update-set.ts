import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getCredentials } from '@servicenow/sdk-cli/dist/auth/index.js';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../sn/ServiceNowInstance';
import { UpdateSetManager } from '../sn/updateset/UpdateSetManager';

async function main(): Promise<void> {
    const updateSetSysId = process.argv[2];
    const outputDirArg = process.argv[3];

    if (!updateSetSysId?.trim() || !outputDirArg?.trim()) {
        console.error('Usage: node dist/cli/export-update-set.js <updateSetSysId> <outputDirectory>');
        console.error('Requires SN_INSTANCE_ALIAS (e.g. in .env) matching your ServiceNow CLI credential alias.');
        process.exitCode = 1;
        return;
    }

    const alias = process.env.SN_INSTANCE_ALIAS?.trim();
    if (!alias) {
        console.error('SN_INSTANCE_ALIAS is not set. Add it to .env or export it in the shell.');
        process.exitCode = 1;
        return;
    }

    const credential = await getCredentials(alias);
    if (!credential) {
        console.error(`No credentials found for alias: ${alias}`);
        process.exitCode = 1;
        return;
    }

    const snSettings: ServiceNowSettingsInstance = {
        alias,
        credential,
    };
    const instance = new ServiceNowInstance(snSettings);
    const manager = new UpdateSetManager(instance);

    const xml = await manager.exportUpdateSet(updateSetSysId.trim());
    const outDir = resolve(outputDirArg.trim());
    await mkdir(outDir, { recursive: true });
    const filePath = join(outDir, `update-set-${updateSetSysId.trim()}.xml`);
    await writeFile(filePath, xml, 'utf8');
    console.log(`Wrote ${filePath}`);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
