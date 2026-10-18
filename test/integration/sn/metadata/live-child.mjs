// Keep the credential shim and all SDK consumers in the native Node module registry.
import {runLifecycle} from './lifecycle.mjs';
try {
    await runLifecycle();
    process.stderr.write('Metadata lifecycle L0-L6 complete. Safe results saved.\n');
} catch {
    // Raw SDK/assertion errors can contain credentials or private record values.
    process.stderr.write('Metadata lifecycle failed. Review the private evidence; do not replay writes.\n');
    process.exitCode=1;
}
