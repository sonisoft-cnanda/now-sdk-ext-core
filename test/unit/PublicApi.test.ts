import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

/**
 * Regression guard for the public API surface.
 *
 * The defect this exists for: `ScriptTracer` was exported while `AMBClient` —
 * required by its constructor — was not, so no consumer could construct one
 * through the package's public API. `MessageClientBuilder.createClient()` was
 * unreachable as a factory too, and README.md documented an import that could
 * not compile.
 *
 * WHY THIS INSPECTS dist/ RATHER THAN IMPORTING THE BARREL
 * -------------------------------------------------------
 * Importing `src/index` pulls in `sn/amb/AMBClient` -> `MessageClient` ->
 * `cometd`, which is `"type": "module"` and which jest cannot load under this
 * config ("SyntaxError: Unexpected token 'export'"). That is why the existing
 * test/unit/amb/AMBClient.test.ts inspects source text instead of importing.
 *
 * The original defect was a *missing export* — a compile-time failure — so
 * `dist/index.d.ts` is the right thing to check: it is the actual published
 * contract, and whatever it exports is what a consumer can import.
 *
 * Symbols are resolved with the TypeScript compiler API rather than by grepping
 * the .d.ts text. Text matching is not good enough here: an earlier version of
 * this test passed while `AMBClient` was NOT exported, because the name still
 * appeared inside ScriptTracer's constructor signature — and it also reported a
 * false failure by matching a doc comment that tsc had emitted into the .d.ts.
 *
 * CI builds before running unit tests, so dist/ is present. Locally it may not
 * be, in which case these skip loudly rather than passing silently.
 */
// `npm test` runs jest with --experimental-vm-modules, so this file executes as
// real ESM where __dirname does not exist. Same pattern as test/unit/amb/AMBClient.test.ts.
const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '../../dist');
const barrel = path.join(distDir, 'index.d.ts');
const hasBuild = fs.existsSync(barrel);

if (!hasBuild) {
    console.warn(
        '[PublicApi.test] dist/index.d.ts not found — run `npm run build` first. ' +
            'Public API assertions skipped.',
    );
}

/** Names actually exported by the built barrel, per the TypeScript checker. */
function exportedNames(): string[] {
    const program = ts.createProgram([barrel], { declaration: true });
    const source = program.getSourceFile(barrel);
    if (!source) throw new Error(`could not load ${barrel}`);
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`${barrel} is not a module`);
    return checker.getExportsOfModule(moduleSymbol).map((s) => s.getName());
}

(hasBuild ? describe : describe.skip)('public API surface (dist/index.d.ts)', () => {
    it('exports the AMB types needed to construct a ScriptTracer', () => {
        const names = exportedNames();
        for (const name of ['AMBClient', 'MessageClientBuilder', 'Channel', 'ChannelListener']) {
            expect(names).toContain(name);
        }
    });

    it('exports ScriptTracer alongside the type its constructor requires', () => {
        // Exporting one without the other is the exact shape of the original bug.
        const names = exportedNames();
        expect(names).toContain('ScriptTracer');
        expect(names).toContain('AMBClient');
    });

    it('still exports AuthenticatedWebSocket, which 3.9.0 published', () => {
        // Verified against the published 3.9.0 dist/index.d.ts — removing it
        // would break the existing public contract.
        expect(exportedNames()).toContain('AuthenticatedWebSocket');
    });

    it('exports StaleInstanceError so callers can identify a cross-instance refusal', () => {
        // The guard is only useful if consumers can distinguish it from a generic
        // failure — retrying is the right response to this error and the wrong
        // response to most others.
        const names = exportedNames();
        expect(names).toContain('StaleInstanceError');
        expect(names).toContain('isStaleInstanceError');
    });

    it('exports the progress callback surface for long-running operations', () => {
        // Consumers cannot pass onProgress to installStoreApplicationAndWait or
        // waitForTestSuiteCompletion without the type, and cannot build their own
        // dedupe without the emitter.
        const names = exportedNames();
        expect(names).toContain('createProgressEmitter');
        expect(names).toContain('OperationProgress');
        expect(names).toContain('OperationProgressCallback');
    });

    it('does not export SessionManager', () => {
        // Deliberately internal (removed from the barrel in f5379e4). ctix used
        // to re-add it on every full build; the barrel is hand-authored now so
        // that cannot happen silently.
        expect(exportedNames()).not.toContain('SessionManager');
    });

    it('does not leak the CometD transport internals', () => {
        // These are ~2,900 lines of protocol plumbing. Publishing them would
        // make every refactor semver-major, and exporting `XMLHttpRequest`
        // would shadow the DOM global for `import * as core`.
        const names = exportedNames();
        for (const internal of ['XMLHttpRequest', 'ServerConnection', 'SubscriptionCommandSender']) {
            expect(names).not.toContain(internal);
        }
    });
});
