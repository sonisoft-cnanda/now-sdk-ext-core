/**
 * A workflow publish that validation blocked.
 *
 * `level` is `critical` when the instance refuses to publish at all, and `warning` when
 * it would publish only after confirmation (pass `allowWarnings` to accept warnings).
 * `items` holds the individual Warn/Critical findings when they could be read.
 */
export class WorkflowValidationError extends Error {
    public readonly versionSysId: string;
    public readonly level: 'warning' | 'critical';
    public readonly summary: string;
    public readonly items: Array<{ type: string; level: string; message: string; details: string }>;

    public constructor(
        versionSysId: string,
        level: 'warning' | 'critical',
        summary: string,
        items: Array<{ type: string; level: string; message: string; details: string }> = [],
    ) {
        const findings = items.map(i => `[${i.level}] ${i.type}: ${i.message}`).join('\n');
        super(`Workflow version ${versionSysId} was not published: validation ${level === 'critical' ? 'failed' : 'reported warnings'}.`
            + (summary ? `\n${summary}` : '') + (findings ? `\n${findings}` : ''));
        this.name = 'WorkflowValidationError';
        this.versionSysId = versionSysId;
        this.level = level;
        this.summary = summary;
        this.items = items;
    }
}
