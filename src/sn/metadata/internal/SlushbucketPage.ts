import { Parser } from 'htmlparser2';

/** The parts of the classic Form Layout page (`/slushbucket.do?sysparm_form=section`) a save needs. */
export interface SlushbucketPage {
    /** Hidden inputs of the `editPage` form, first value per name. */
    inputs: Record<string, string>;
    /** Option values of the Available bucket (`select_0`), in page order. */
    available: string[];
    /** Option values of the Selected bucket (`select_1`): the section's current layout, in order. */
    selected: string[];
    /** Whether the page rendered a Save button. */
    canSave: boolean;
}

/** Parse the Form Layout page. Throws when the page has no `editPage` form (a login or error page). */
export function parseSlushbucketPage(html: string): SlushbucketPage {
    const inputs: Record<string, string> = {};
    const buckets: Record<string, string[]> = { select_0: [], select_1: [] };
    let inForm = false, sawForm = false, canSave = false;
    let bucket: string | undefined;
    const parser = new Parser({
        onopentag(tag, attrs) {
            if (tag === 'form') {
                inForm = attrs.name === 'editPage';
                sawForm ||= inForm;
                return;
            }
            if (!inForm) return;
            if (tag === 'input' && attrs.name && (attrs.type ?? '').toLowerCase() === 'hidden' && !(attrs.name in inputs && inputs[attrs.name])) {
                inputs[attrs.name] = attrs.value ?? '';
            }
            if (tag === 'select' && (attrs.name === 'select_0' || attrs.name === 'select_1')) bucket = attrs.name;
            if (tag === 'option' && bucket && attrs.value !== undefined) buckets[bucket].push(attrs.value);
            if (tag === 'button' && attrs.id === 'sysverb_save') canSave = true;
        },
        onclosetag(tag) {
            if (tag === 'select') bucket = undefined;
            if (tag === 'form') inForm = false;
        },
    }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
    parser.write(html);
    parser.end();
    if (!sawForm) throw new Error('Not a Form Layout page');
    return { inputs, available: buckets.select_0, selected: buckets.select_1, canSave };
}

/** The Section select's option values from the GlideViewManager `refreshSection` response, in order. */
export function parseSectionChoices(xml: string): string[] {
    const values: string[] = [];
    let inSections = false;
    const parser = new Parser({
        onopentag(tag, attrs) {
            if (tag === 'sections') inSections = true;
            if (inSections && tag === 'choice' && attrs.value) values.push(attrs.value);
        },
        onclosetag(tag) { if (tag === 'sections') inSections = false; },
    }, { xmlMode: true, decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
    parser.write(xml);
    parser.end();
    return values;
}

/** The page's `saveAllSelected` join: comma-separated, commas inside a value escaped. */
export function joinLayoutValues(values: string[]): string {
    return values.map(value => value.replace(/,/g, '\\,')).join(',');
}
