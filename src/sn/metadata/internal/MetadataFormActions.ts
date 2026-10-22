import { MetadataScopeError } from '../MetadataScopeError';
import type { MetadataReader } from './MetadataReader';

const ID = /^[a-f0-9]{32}$/i;

/**
 * The form's Delete must be the platform's own global Delete action, the one whose client script only confirms and posts
 * `sysverb_delete`. A table's own Delete action may do something else, so posting the verb would not be what it does.
 */
export async function requirePlatformDelete(reader: MetadataReader, actions: Record<string, string>): Promise<void> {
    const actionId = actions.sysverb_delete;
    if (!actionId) throw new MetadataScopeError('not_permitted');
    if (!ID.test(actionId)) throw new MetadataScopeError('delete_not_supported');
    const definition = await reader.exact('sys_ui_action', actionId, 'table,action_name,onclick,name');
    if (!definition || definition.table !== 'global' || definition.action_name !== 'sysverb_delete' ||
        definition.name !== 'Delete' || !/^\s*(?:return\s+)?confirmAndDeleteFromForm\(\);?\s*$/.test(definition.onclick)) {
        throw new MetadataScopeError('delete_not_supported');
    }
}
