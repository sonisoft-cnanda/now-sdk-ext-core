import { isPolicyRefusal } from "../../policy/PolicyRefusal";
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from "../../util/Logger";
import { ScriptSync } from './ScriptSync';
import { SyncResult } from './ScriptSyncModels';

export interface WatchOptions {
    directory: string;
    scriptType?: string;
    autoSync?: boolean;
    onSync?: (result: SyncResult) => void;
}

/**
 * ScriptWatcher watches a directory for file changes and automatically
 * pushes updated scripts to ServiceNow using ScriptSync.
 */
export class ScriptWatcher {
    private _logger: Logger = new Logger("ScriptWatcher");
    private _scriptSync: ScriptSync;
    private _watcher: fs.FSWatcher | null = null;

    public constructor(scriptSync: ScriptSync) {
        this._scriptSync = scriptSync;
    }

    /**
     * Start watching a directory for file changes.
     * On 'change' events, auto-pushes the changed file to ServiceNow.
     * Returns an object with a stop() function to close the watcher.
     */
    public start(options: WatchOptions): { stop: () => void } {
        const { directory, scriptType, autoSync = true, onSync } = options;

        this._logger.info(`Starting file watcher on directory: ${directory}`);

        this._watcher = fs.watch(directory, (eventType: string, filename: string | null) => {
            if (eventType !== 'change' || !filename || !autoSync) {
                return;
            }

            const parsed = ScriptSync.parseFileName(filename);
            if (!parsed.isValid) {
                return;
            }

            // If scriptType filter is set, only sync matching types
            if (scriptType && parsed.scriptType !== scriptType) {
                return;
            }

            const filePath = path.join(directory, filename);

            this._logger.info(`File changed: ${filename}, pushing to ServiceNow...`);

            this._scriptSync.pushScript({
                scriptName: parsed.scriptName!,
                scriptType: parsed.scriptType!,
                filePath
            }).then((result: SyncResult) => {
                if (onSync) {
                    onSync(result);
                }
                if (result.success) {
                    this._logger.info(`Auto-sync succeeded for ${filename}`);
                } else {
                    this._logger.error(`Auto-sync failed for ${filename}: ${result.error || result.message}`);
                }
            }).catch((error: Error) => {
                // A refusal is the policy working, not a sync error.
                if (isPolicyRefusal(error)) this._logger.warn(`Auto-sync of ${filename} refused by policy: ${error.message}`);
                else this._logger.error(`Auto-sync error for ${filename}: ${error.message}`);
            });
        });

        const self = this;
        return {
            stop: () => {
                self.stop();
            }
        };
    }

    /**
     * Stop the file watcher.
     */
    public stop(): void {
        if (this._watcher) {
            this._logger.info('Stopping file watcher');
            this._watcher.close();
            this._watcher = null;
        }
    }
}
