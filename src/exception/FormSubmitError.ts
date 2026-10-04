/**
 * A classic UI form submit that the instance did not accept.
 *
 * `messages` holds the error messages the instance rendered (e.g. "Invalid insert",
 * a data-policy or ACL message). It is empty when the instance rejected the submit
 * without saying why — typically a redirect to a page that is not the expected
 * form response.
 */
export class FormSubmitError extends Error {
    public readonly table: string;
    public readonly messages: string[];

    public constructor(table: string, message: string, messages: string[] = []) {
        super(messages.length ? `${message}: ${messages.join('; ')}` : message);
        this.name = 'FormSubmitError';
        this.table = table;
        this.messages = messages;
    }
}
