/**
 * Unit tests for WorkflowManager's Workflow Editor–parity methods (checkout, edit, publish).
 * The diagram processor client, the form writer and Table API reads are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { WorkflowManager } from '../../../../src/sn/workflow/WorkflowManager';
import { WorkflowValidationError } from '../../../../src/exception/WorkflowValidationError';
import { InvalidParameterException } from '../../../../src/exception/InvalidParameterException';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { READ_ONLY } from '../../../../src/policy/PolicyTypes';
import { createGetCredentialsMock } from '../../__mocks__/servicenow-sdk-mocks';
import { buildExport } from './workflowExportBuilder';

const mockGetCredentials = createGetCredentialsMock();
jest.mock('@servicenow/sdk-cli/dist/auth/index.js', () => ({ getCredentials: mockGetCredentials }));

const id = (c: string) => c.repeat(32);
const ME = id('1');
const OTHER = id('2');
const WF = id('3');
const PUBLISHED = id('4');
const DRAFT = id('5');
const BEGIN = id('6');
const END = id('7');
const ALWAYS = id('8');
const TRANSITION = id('9');
const NEW_ACT = id('a');
const NEW_EXIT = id('b');
const TIMER_DEF = '3961a1da0a0a0b5c00ecd84822f70d85';

type Row = Record<string, string>;
type Route = [table: string, match: string | RegExp, rows: Row[] | (() => Row[])];

describe('WorkflowManager - Workflow Editor parity', () => {
    let wm: WorkflowManager;
    let routes: Route[];
    let read: jest.Mock<any>;
    let diagram: Record<string, jest.Mock<any>>;
    let forms: { insert: jest.Mock<any>; update: jest.Mock<any> };
    let tableAPI: { post: jest.Mock<any>; put: jest.Mock<any>; get: jest.Mock<any> };

    const draftVersion = (extra: Row = {}): Row => ({
        sys_id: DRAFT, workflow: WF, name: 'My WF', table: 'incident', published: 'false', active: 'true',
        checked_out: '2026-10-04 10:00:00', checked_out_by: ME, 'checked_out_by.name': 'Me', start: BEGIN, ...extra,
    });

    beforeEach(async () => {
        const credential = await mockGetCredentials('test-instance');
        const instance = new ServiceNowInstance({ alias: 'test-instance', credential } as ServiceNowSettingsInstance);
        wm = new WorkflowManager(instance);

        routes = [];
        read = jest.fn(async (table: string, query: string) => {
            const route = routes.find(([t, m]) => t === table && (typeof m === 'string' ? query === m : m.test(query)));
            if (!route) throw new Error(`Unrouted read: ${table} ${query}`);
            return typeof route[2] === 'function' ? route[2]() : route[2];
        });
        (wm as any).read = read;
        (wm as any).currentUserSysId = jest.fn(async () => ME);

        diagram = Object.fromEntries(['get', 'getNode', 'checkout', 'forceCheckout', 'publish', 'delete', 'setActive', 'moveNodes',
            'newEdge', 'changeEdge', 'deleteEdge', 'newEdgeControlNode', 'deleteNode', 'updateStages']
            .map(name => [name, jest.fn(async () => undefined)]));
        (wm as any)._diagram = diagram;
        forms = { insert: jest.fn(), update: jest.fn() };
        (wm as any)._forms = forms;
        tableAPI = { post: jest.fn(), put: jest.fn(), get: jest.fn() };
        (wm as any)._tableAPI = tableAPI;
    });

    afterEach(() => jest.restoreAllMocks());

    describe('resolveWorkflow / findWorkflows', () => {
        it('resolves a version sys_id to its workflow and summarizes published and draft versions', async () => {
            routes.push(
                ['wf_workflow', `sys_id=${DRAFT}`, []],
                ['wf_workflow_version', `sys_id=${DRAFT}`, [{ workflow: WF }]],
                ['wf_workflow', `sys_id=${WF}`, [{ sys_id: WF, name: 'My WF', table: 'incident', description: '' }]],
                ['wf_workflow_version', /^workflowIN/, [
                    { sys_id: PUBLISHED, workflow: WF, published: 'true', active: 'true', checked_out: '', checked_out_by: '' },
                    draftVersion(),
                ]],
            );
            await expect(wm.resolveWorkflow(DRAFT)).resolves.toEqual({
                sysId: WF, name: 'My WF', table: 'incident', description: '', active: true,
                publishedVersionSysId: PUBLISHED,
                checkedOutVersion: { sysId: DRAFT, checkedOutBy: ME, checkedOutByName: 'Me', checkedOutOn: '2026-10-04 10:00:00', byCurrentUser: true },
            });
        });

        it('refuses an ambiguous or unknown name', async () => {
            routes.push(['wf_workflow', 'name=Dup', [{ sys_id: WF, table: 'a' }, { sys_id: OTHER, table: 'b' }]], ['wf_workflow', 'name=None', []]);
            await expect(wm.resolveWorkflow('Dup')).rejects.toThrow(/matches 2 workflows/);
            await expect(wm.resolveWorkflow('None')).rejects.toThrow("No workflow found for 'None'");
        });

        it('refuses names that would alter the encoded query', async () => {
            await expect(wm.resolveWorkflow('x^ORname!=y')).rejects.toThrow(InvalidParameterException);
            await expect(wm.findWorkflows({ name: 'a^NQsys_id!=b' })).rejects.toThrow("The name cannot contain '^'");
            expect(read).not.toHaveBeenCalled();
        });

        it('builds the find query from options', async () => {
            routes.push(['wf_workflow', 'nameLIKEReq^table=sc_req_item^active=true^ORDERBYname', []]);
            await expect(wm.findWorkflows({ name: 'Req', table: 'sc_req_item', query: 'active=true' })).resolves.toEqual([]);
        });
    });

    describe('checkout', () => {
        const summary = (draft?: Row) => {
            routes.push(['wf_workflow', 'name=My WF', [{ sys_id: WF, name: 'My WF', table: 'incident', description: '' }]]);
            routes.push(['wf_workflow_version', /^workflowIN/, [
                { sys_id: PUBLISHED, workflow: WF, published: 'true', active: 'true', checked_out_by: '' },
                ...(draft ? [draft] : []),
            ]]);
        };

        it('checks out the published version into a new draft', async () => {
            summary();
            diagram.checkout.mockResolvedValueOnce({ id: DRAFT, readOnly: false });
            await expect(wm.checkout('My WF')).resolves.toEqual({ workflowSysId: WF, versionSysId: DRAFT, alreadyCheckedOut: false });
            expect(diagram.checkout).toHaveBeenCalledWith(PUBLISHED, 'My WF');
        });

        it('returns the current user\'s existing draft', async () => {
            summary(draftVersion());
            await expect(wm.checkout('My WF')).resolves.toEqual({ workflowSysId: WF, versionSysId: DRAFT, alreadyCheckedOut: true });
            expect(diagram.checkout).not.toHaveBeenCalled();
        });

        it('refuses another user\'s checkout unless forced', async () => {
            summary(draftVersion({ checked_out_by: OTHER, 'checked_out_by.name': 'Someone Else' }));
            await expect(wm.checkout('My WF')).rejects.toThrow(/checked out by Someone Else/);

            summary(draftVersion({ checked_out_by: OTHER }));
            diagram.forceCheckout.mockResolvedValueOnce({ id: DRAFT });
            await expect(wm.checkout('My WF', { force: true })).resolves.toMatchObject({ versionSysId: DRAFT });
            expect(diagram.forceCheckout).toHaveBeenCalledWith(PUBLISHED);
            diagram.forceCheckout.mockResolvedValueOnce({ id: PUBLISHED, readOnly: true, statusDisplay: 'Checked out by Other' });
            await expect(wm.checkout('My WF', { force: true })).rejects.toThrow("could not be checked out (Checked out by Other)");
        });

        it('finds the current user\'s draft, and explains when there is none to use', async () => {
            summary(draftVersion());
            await expect(wm.getDraftVersion('My WF')).resolves.toBe(DRAFT);
            routes.length = 0;
            summary();
            await expect(wm.getDraftVersion('My WF')).rejects.toThrow(/is not checked out/);
            routes.length = 0;
            summary(draftVersion({ checked_out_by: OTHER, 'checked_out_by.name': 'Someone' }));
            await expect(wm.getDraftVersion('My WF')).rejects.toThrow(/checked out by Someone, not the current user/);
        });

        it('fails when the instance does not create a draft', async () => {
            summary();
            diagram.checkout.mockResolvedValueOnce({ id: PUBLISHED, readOnly: true, statusDisplay: 'Published' });
            await expect(wm.checkout('My WF')).rejects.toThrow(/could not be checked out \(Published\)/);
        });
    });

    describe('publish', () => {
        const findings = [{ type: 'ValidateTransitionIn', level: 'Warn', message: 'Missing transition', details: '' }];

        beforeEach(() => {
            routes.push(['wf_workflow_version', `sys_id=${DRAFT}`, [draftVersion()]]);
            jest.spyOn(wm, 'validateWorkflow').mockResolvedValue({ versionSysId: DRAFT, summary: 's', valid: false, items: [
                { type: 'ValidateSingleEnd', level: 'Info', message: 'ok', details: '' }, ...findings] });
        });

        it('publishes a valid draft', async () => {
            diagram.publish.mockResolvedValueOnce({ graph: { published: true, fullSequences: [BEGIN, END] }, messages: {} });
            await expect(wm.publish(DRAFT)).resolves.toEqual({ versionSysId: DRAFT, warnings: [], fullSequences: [BEGIN, END] });
            expect(diagram.publish).toHaveBeenCalledWith(DRAFT, true);
        });

        it('stops on warnings unless allowed, reporting the findings', async () => {
            const warning = { messages: { validationWarning: 'Validation warning.\n\nValidate Summary  - Workflow version contains Warnings - (Warn:1)\n\nPublish?' } };
            diagram.publish.mockResolvedValueOnce(warning);
            const error = await wm.publish(DRAFT).catch(e => e);
            expect(error).toBeInstanceOf(WorkflowValidationError);
            expect(error).toMatchObject({ level: 'warning', items: findings, summary: 'Validate Summary - Workflow version contains Warnings - (Warn:1)' });

            diagram.publish.mockResolvedValueOnce(warning).mockResolvedValueOnce({ graph: { published: true, fullSequences: [] }, messages: {} });
            await expect(wm.publish(DRAFT, { allowWarnings: true })).resolves.toMatchObject({ warnings: findings });
            expect(diagram.publish).toHaveBeenLastCalledWith(DRAFT, false);
        });

        it('always stops on critical findings', async () => {
            diagram.publish.mockResolvedValueOnce({ messages: { validationCritical: 'Nope' } });
            await expect(wm.publish(DRAFT, { allowWarnings: true })).rejects.toMatchObject({ level: 'critical' });
            expect(diagram.publish).toHaveBeenCalledTimes(1);
        });

        it('only publishes the current user\'s draft', async () => {
            routes.unshift(['wf_workflow_version', `sys_id=${PUBLISHED}`, [draftVersion({ sys_id: PUBLISHED, published: 'true' })]]);
            await expect(wm.publish(PUBLISHED)).rejects.toThrow(/is published. Check the workflow out/);
            routes.unshift(['wf_workflow_version', `sys_id=${OTHER}`, [draftVersion({ sys_id: OTHER, checked_out_by: OTHER, 'checked_out_by.name': 'Someone' })]]);
            await expect(wm.publish(OTHER)).rejects.toThrow(/is checked out by Someone/);
            expect(diagram.publish).not.toHaveBeenCalled();
        });
    });

    describe('discardCheckout', () => {
        it('deletes the draft but never the only version', async () => {
            routes.push(['wf_workflow_version', `sys_id=${DRAFT}`, [draftVersion()]]);
            routes.push(['wf_workflow_version', `workflow=${WF}^sys_id!=${DRAFT}`, []]);
            await expect(wm.discardCheckout(DRAFT)).rejects.toThrow(/only version/);
            expect(diagram.delete).not.toHaveBeenCalled();
        });
    });

    describe('addActivity', () => {
        beforeEach(() => {
            routes.push(
                ['wf_workflow_version', `sys_id=${DRAFT}`, [draftVersion()]],
                ['wf_element_definition', 'name=Timer', [{ sys_id: TIMER_DEF, name: 'Timer', category: 'Timers', sys_class_name: 'wf_activity_definition' }]],
                ['wf_transition', `sys_id=${TRANSITION}`, [{ sys_id: TRANSITION, from: BEGIN, to: END, condition: ALWAYS,
                    'from.workflow_version': DRAFT, 'from.x': '20', 'from.y': '20', 'to.x': '400', 'to.y': '150' }]],
                ['wf_condition', `activity=${NEW_ACT}^ORDERBYorder`, [{ sys_id: NEW_EXIT, activity: NEW_ACT, name: 'Always', condition: 'true', order: '0' }]],
            );
            forms.insert.mockResolvedValue({ sysId: NEW_ACT, action: 'sysverb_insert', messages: [] });
        });

        it('creates the activity through the form and drops it onto a line like the editor', async () => {
            const result = await wm.addActivity(DRAFT, {
                definition: 'Timer', name: 'Wait', insertOn: TRANSITION, variables: { timer_type: 'script', script: 'answer = 5;' },
            });

            expect(forms.insert).toHaveBeenCalledWith('wf_activity', {
                view: 'diagrammer',
                initialQuery: `workflow_version=${DRAFT}^activity_definition=${TIMER_DEF}`,
                fields: { name: 'Wait', x: 210, y: 85 },
                variables: { timer_type: 'script', script: 'answer = 5;' },
            });
            const [version, node, changed, added] = diagram.newEdgeControlNode.mock.calls[0];
            expect(version).toBe(DRAFT);
            expect(node).toEqual({ id: NEW_ACT, x: 210, y: 85 });
            expect(changed).toEqual([{ id: TRANSITION, source: BEGIN, sourcePort: ALWAYS, target: NEW_ACT }]);
            expect(added).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{32}$/), source: NEW_ACT, sourcePort: NEW_EXIT, target: END }]);
            expect(diagram.updateStages).toHaveBeenCalledWith(DRAFT);
            expect(result).toMatchObject({ activitySysId: NEW_ACT, transitionSysIds: [TRANSITION, added[0].id] });
            expect(result.conditions[0]).toMatchObject({ sysId: NEW_EXIT, name: 'Always' });
        });

        it('takes the new activity out again when the exit to wire from does not exist', async () => {
            let deleted = false;
            diagram.deleteNode.mockImplementation(async () => { deleted = true; });
            routes.push(
                ['wf_activity', `sys_id=${END}`, [{ sys_id: END, name: 'End', workflow_version: DRAFT }]],
                ['wf_activity', `sys_id=${NEW_ACT}`, () => deleted ? [] : [{ sys_id: NEW_ACT, name: 'Wait', workflow_version: DRAFT,
                    'activity_definition.name': 'Timer', 'activity_definition.attributes': '' }]],
                ['wf_transition', `from=${NEW_ACT}^ORto=${NEW_ACT}`, []],
            );
            await expect(wm.addActivity(DRAFT, { definition: 'Timer', name: 'Wait', connectTo: END, exitCondition: 'Nope' }))
                .rejects.toThrow("'Wait' has no exit 'Nope'. Exits: Always");
            expect(forms.insert).toHaveBeenCalledTimes(1);
            expect(diagram.deleteNode.mock.calls[0][1]).toBe(NEW_ACT);
            expect(diagram.newEdge).not.toHaveBeenCalled();
        });

        it('names the added activity when wiring it fails', async () => {
            diagram.newEdgeControlNode.mockRejectedValueOnce(new Error('processor said no'));
            await expect(wm.addActivity(DRAFT, { definition: 'Timer', name: 'Wait', insertOn: TRANSITION }))
                .rejects.toThrow(`processor said no (activity 'Wait' ${NEW_ACT} was added to the draft; its wiring is incomplete)`);
        });

        it('refuses an exit name that several exits share', async () => {
            const IF = id('c');
            routes.push(
                ['wf_activity', `sys_id=${IF}`, [{ sys_id: IF, name: 'Check', workflow_version: DRAFT }]],
                ['wf_condition', `activity=${IF}^ORDERBYorder`, [
                    { sys_id: id('d'), activity: IF, name: 'Yes', order: '100' }, { sys_id: id('e'), activity: IF, name: 'yes', order: '200' }]],
            );
            await expect(wm.addActivity(DRAFT, { definition: 'Timer', name: 'Wait', connectFrom: { activity: IF, condition: 'Yes' } }))
                .rejects.toThrow(`'Check' has 2 exits named 'Yes'; use a sys_id: ${id('d')}, ${id('e')}`);
            expect(forms.insert).not.toHaveBeenCalled();
        });

        it('checks the ids the record API puts into the activity form', async () => {
            await expect(wm.createActivity({ name: 'Wait', workflowVersionSysId: DRAFT, activityDefinitionSysId: `${TIMER_DEF}^workflow_version=${OTHER}`,
                variables: { script: 'answer = 1;' } })).rejects.toThrow(InvalidParameterException);
            expect(forms.insert).not.toHaveBeenCalled();
        });

        it('refuses a stage name that several stages share', async () => {
            routes.push(['wf_stage', `workflow_version=${DRAFT}`, [{ sys_id: 's1', name: 'Fulfil', value: 'a' }, { sys_id: 's2', name: 'Fulfil', value: 'b' }]]);
            await expect(wm.addActivity(DRAFT, { definition: 'Timer', name: 'Wait', stage: 'fulfil' }))
                .rejects.toThrow(`2 stages match 'fulfil' on workflow version ${DRAFT}; use a sys_id: s1, s2`);
        });

        it('requires an exit choice when connecting from an activity with several', async () => {
            const IF = id('c');
            routes.push(
                ['wf_activity', `sys_id=${IF}`, [{ sys_id: IF, name: 'Check', workflow_version: DRAFT, x: '100', y: '100' }]],
                ['wf_condition', `activity=${IF}^ORDERBYorder`, [
                    { sys_id: id('d'), activity: IF, name: 'Yes', order: '100' }, { sys_id: id('e'), activity: IF, name: 'No', order: '200' }]],
            );
            await expect(wm.addActivity(DRAFT, { definition: 'Timer', name: 'Wait', connectFrom: { activity: IF } }))
                .rejects.toThrow("'Check' has several exits; specify one of: Yes, No");
            expect(forms.insert).not.toHaveBeenCalled();

            await wm.addActivity(DRAFT, { definition: 'Timer', name: 'Wait', connectFrom: { activity: IF, condition: 'no' } });
            expect(diagram.newEdge.mock.calls[0][1]).toMatchObject({ source: IF, sourcePort: id('e'), target: NEW_ACT });
            expect(forms.insert.mock.calls[0][1].fields).toEqual({ name: 'Wait', x: 280, y: 100 });
        });

        it('prefers the core activity when a name is shared with Activity Designer ones, and refuses true ambiguity', async () => {
            routes.push(['wf_element_definition', 'name=Notify', [
                { sys_id: id('d'), name: 'Notify', sys_class_name: 'wf_element_activity' },
                { sys_id: id('e'), name: 'Notify', sys_class_name: 'wf_activity_definition' }]]);
            routes.push(['wf_element_definition', 'name=Add User', [
                { sys_id: id('d'), name: 'Add User', sys_class_name: 'wf_element_activity' },
                { sys_id: id('f'), name: 'Add User', sys_class_name: 'wf_element_activity' }]]);
            await wm.addActivity(DRAFT, { definition: 'Notify', name: 'n', x: 1, y: 1 });
            expect(forms.insert.mock.calls[0][1].initialQuery).toContain(`activity_definition=${id('e')}`);
            await expect(wm.addActivity(DRAFT, { definition: 'Add User', name: 'n' })).rejects.toThrow(/matches 2 activity definitions/);
        });

        it('refuses activities from another version', async () => {
            routes.push(['wf_activity', `sys_id=${id('c')}`, [{ sys_id: id('c'), name: 'Elsewhere', workflow_version: PUBLISHED }]]);
            await expect(wm.addActivity(DRAFT, { definition: 'Timer', name: 'Wait', connectTo: id('c') }))
                .rejects.toThrow(/belongs to a different workflow version/);
            expect(forms.insert).not.toHaveBeenCalled();
        });
    });

    describe('updateActivity / removeActivity', () => {
        const MID = id('c');
        beforeEach(() => {
            let deleted = false;
            diagram.deleteNode.mockImplementation(async () => { deleted = true; });
            routes.push(['wf_workflow_version', `sys_id=${DRAFT}`, [draftVersion()]]);
            routes.push(['wf_activity', `sys_id=${MID}`, () => deleted ? [] : [{ sys_id: MID, name: 'Mid', workflow_version: DRAFT, x: '10', y: '20',
                'activity_definition.name': 'Timer', 'activity_definition.attributes': '' }]]);
        });

        it('updates variables through the form and moves through the diagram', async () => {
            await wm.updateActivity(MID, { variables: { script: 'answer = 1;' }, x: 99 });
            expect(forms.update).toHaveBeenCalledWith('wf_activity', MID, { view: 'diagrammer', fields: {}, variables: { script: 'answer = 1;' } });
            expect(diagram.moveNodes).toHaveBeenCalledWith(DRAFT, [{ id: MID, x: 99, y: 20 }]);
        });

        it('joins the single incoming and outgoing transitions when reconnecting', async () => {
            routes.push(['wf_transition', `from=${MID}^ORto=${MID}`, [
                { sys_id: id('d'), from: BEGIN, to: MID, condition: ALWAYS },
                { sys_id: id('e'), from: MID, to: END, condition: NEW_EXIT },
            ]]);
            routes.push(['wf_transition', `condition=${ALWAYS}^to=${END}^sys_id!=${id('d')}`, []]);

            await wm.removeActivity(MID, { reconnect: true });
            expect(diagram.deleteNode).toHaveBeenCalledWith(DRAFT, MID,
                [{ id: id('e'), source: MID, sourcePort: NEW_EXIT, target: END }],
                [{ id: id('d'), source: BEGIN, sourcePort: ALWAYS, target: END }]);
        });

        it('drops both transitions instead of drawing a duplicate path', async () => {
            routes.push(['wf_transition', `from=${MID}^ORto=${MID}`, [
                { sys_id: id('d'), from: BEGIN, to: MID, condition: ALWAYS },
                { sys_id: id('e'), from: MID, to: END, condition: NEW_EXIT },
            ]]);
            routes.push(['wf_transition', `condition=${ALWAYS}^to=${END}^sys_id!=${id('d')}`, [{ sys_id: TRANSITION }]]);

            await wm.removeActivity(MID, { reconnect: true });
            expect(diagram.deleteNode.mock.calls[0][2]).toHaveLength(2);
            expect(diagram.deleteNode.mock.calls[0][3]).toBeUndefined();
        });

        it('refuses to remove Begin or End', async () => {
            routes.unshift(['wf_activity', `sys_id=${BEGIN}`, [{ sys_id: BEGIN, name: 'Begin', workflow_version: DRAFT,
                'activity_definition.name': 'Begin', 'activity_definition.attributes': 'begin=true' }]]);
            await expect(wm.removeActivity(BEGIN)).rejects.toThrow(InvalidParameterException);
            expect(diagram.deleteNode).not.toHaveBeenCalled();
        });
    });

    describe('transitions', () => {
        it('adds a transition from a named exit and refuses duplicates', async () => {
            routes.push(
                ['wf_workflow_version', `sys_id=${DRAFT}`, [draftVersion()]],
                ['wf_activity', `sys_id=${BEGIN}`, [{ sys_id: BEGIN, name: 'Begin', workflow_version: DRAFT }]],
                ['wf_activity', `sys_id=${END}`, [{ sys_id: END, name: 'End', workflow_version: DRAFT }]],
                ['wf_condition', `activity=${BEGIN}^ORDERBYorder`, [{ sys_id: ALWAYS, activity: BEGIN, name: 'Always' }]],
                ['wf_transition', `condition=${ALWAYS}^to=${END}`, []],
            );
            const created = await wm.addTransition({ from: BEGIN, to: END });
            expect(diagram.newEdge).toHaveBeenCalledWith(DRAFT, { id: created, source: BEGIN, sourcePort: ALWAYS, target: END });

            routes.unshift(['wf_transition', `condition=${ALWAYS}^to=${END}`, [{ sys_id: TRANSITION }]]);
            await expect(wm.addTransition({ from: BEGIN, to: END })).rejects.toThrow(/already leads to that activity/);
        });
    });

    describe('newWorkflow', () => {
        it('inserts a version without a workflow and reads back what the instance built', async () => {
            routes.push(
                ['wf_workflow', 'name=Fresh', []],
                ['wf_workflow_version', `sys_id=${DRAFT}`, [draftVersion({ name: 'Fresh' })]],
                ['wf_transition', `from.workflow_version=${DRAFT}`, [{ sys_id: TRANSITION, from: BEGIN, to: END, condition: ALWAYS }]],
            );
            tableAPI.post.mockResolvedValueOnce({ status: 201, bodyObject: { result: { sys_id: DRAFT } } });

            await expect(wm.newWorkflow({ name: 'Fresh', table: 'incident', conditionType: '' })).resolves.toEqual({
                workflowSysId: WF, versionSysId: DRAFT, beginActivitySysId: BEGIN, endActivitySysId: END,
                beginConditionSysId: ALWAYS, transitionSysId: TRANSITION,
            });
            expect(tableAPI.post).toHaveBeenCalledWith('wf_workflow_version', {}, { name: 'Fresh', table: 'incident', condition_type: '' });
        });

        it('refuses a duplicate name', async () => {
            routes.push(['wf_workflow', 'name=Taken', [{ sys_id: WF }]]);
            await expect(wm.newWorkflow({ name: 'Taken', table: 'incident' })).rejects.toThrow(/already exists/);
            expect(tableAPI.post).not.toHaveBeenCalled();
        });
    });

    describe('getWorkflowDefinition', () => {
        it('assembles activities with variables and exits, transitions and status', async () => {
            routes.push(
                ['wf_workflow_version', `sys_id=${DRAFT}`, [draftVersion({ full_sequences: `${BEGIN},${END}` })]],
                ['wf_activity', /^workflow_version=/, [
                    { sys_id: BEGIN, name: 'Begin', activity_definition: 'x', 'activity_definition.name': 'Begin', x: '20', y: '20', width: '80', height: '', stage: '', parent: '', input: '' },
                ]],
                ['wf_condition', /^activity.workflow_version=/, [{ sys_id: ALWAYS, activity: BEGIN, name: 'Always', condition: 'true', order: '0' }]],
                ['wf_transition', /^from.workflow_version=/, [{ sys_id: TRANSITION, from: BEGIN, to: END, condition: ALWAYS }]],
                ['wf_stage', /^workflow_version=/, []],
                ['sys_variable_value', `document=wf_activity^document_keyIN${BEGIN}^ORDERBYorder`, [{ document_key: BEGIN, 'variable.element': 'note', value: 'hi' }]],
            );
            diagram.get.mockResolvedValueOnce({ readOnly: false, canCheckout: false, canForceCheckout: false, canPublish: true, statusDisplay: 'Checked out by me' });

            const definition = await wm.getWorkflowDefinition(DRAFT);
            expect(definition).toMatchObject({
                versionSysId: DRAFT, workflowSysId: WF, published: false, start: BEGIN, fullSequences: [BEGIN, END],
                status: { canPublish: true, statusDisplay: 'Checked out by me' },
                transitions: [{ sysId: TRANSITION, from: BEGIN, to: END, condition: ALWAYS }],
            });
            expect(definition.activities[0]).toMatchObject({ name: 'Begin', definitionName: 'Begin', x: 20, width: 80, height: undefined,
                variables: { note: 'hi' }, conditions: [{ sysId: ALWAYS, name: 'Always' }] });
        });
    });

    describe('activity definitions as the instance defines them', () => {
        const AD = id('d');
        beforeEach(() => {
            (wm as any)._variables = { list: jest.fn(async () => [
                { sysId: '1', model: `var__m_${TIMER_DEF}`, element: 'timer_type', label: 'Timer based on', internalType: 'string', defaultValue: '', mandatory: false, order: 1 },
                { sysId: '2', model: `var__m_${TIMER_DEF}`, element: 'script', label: 'Script', internalType: 'script', defaultValue: '// default\nanswer = 0;', mandatory: false, order: 2 },
            ]) };
            (wm as any).count = jest.fn(async () => 42);
            routes.push(
                ['wf_element_definition', 'name=Timer', [{ sys_id: TIMER_DEF, name: 'Timer', category: 'Timers', sys_class_name: 'wf_activity_definition' }]],
                ['wf_element_definition', `sys_id=${TIMER_DEF}`, [{ description: 'Pauses the workflow.', attributes: '' }]],
                ['wf_condition_default', `activity_definition=${TIMER_DEF}^ORDERBYorder`, []],
                ['wf_activity_definition', `sys_id=${TIMER_DEF}`, [{ script: 'var TimerActivityHandler = Class.create();' }]],
                ['wf_element_definition', `sys_id=${AD}`, [{ sys_id: AD, name: 'Add User to Group', category: '', sys_class_name: 'wf_element_activity',
                    description: 'Adds a user. Results: Success, Failure', attributes: '' }]],
                ['wf_condition_default', `activity_definition=${AD}^ORDERBYorder`, [{ name: 'Success', condition: 'activityOutput.result == "success"', order: '1' }]],
                ['wf_element_activity', `sys_id=${AD}`, [{
                    input_meta: '{"name":"Input","type":"DATA_OBJECT","properties":[{"name":"UserName","type":"STRING","mandatory":true},{"name":"GroupName","type":"STRING"}]}',
                    output_meta: '{"properties":[{"name":"result","type":"STRING"}]}',
                }]],
            );
        });

        it('includes the description, and the handler script only when asked', async () => {
            const plain = await wm.getActivityDefinition('Timer');
            expect(plain).toMatchObject({ name: 'Timer', description: 'Pauses the workflow.', defaultConditions: [] });
            expect(plain.script).toBeUndefined();
            expect(read.mock.calls.some(([table]) => table === 'wf_activity_definition')).toBe(false);
            await expect(wm.getActivityDefinition('Timer', { includeScript: true })).resolves.toMatchObject({ script: 'var TimerActivityHandler = Class.create();' });
        });

        it('describes Activity Designer types by their inputs and outputs', async () => {
            const detail = await wm.getActivityDefinition(AD);
            expect(detail.variables).toEqual([]);
            expect((wm as any)._variables.list).not.toHaveBeenCalled();
            expect(detail.inputs).toEqual([{ name: 'UserName', type: 'STRING', mandatory: true }, { name: 'GroupName', type: 'STRING', mandatory: false }]);
            expect(detail.outputs).toEqual([{ name: 'result', type: 'STRING', mandatory: false }]);
            expect(detail.defaultConditions[0]).toMatchObject({ name: 'Success' });
        });

        it('reports how published workflows configure a type, marking untouched defaults', async () => {
            routes.push(['wf_activity', /^activity_definition=3961/, [{ sys_id: id('1') }, { sys_id: id('2') }, { sys_id: id('3') }]]);
            routes.push(['sys_variable_value', /^document=wf_activity\^document_keyIN/, [
                { document_key: id('1'), 'variable.element': 'timer_type', value: 'script' },
                { document_key: id('2'), 'variable.element': 'timer_type', value: 'script' },
                { document_key: id('3'), 'variable.element': 'timer_type', value: '' },
                { document_key: id('1'), 'variable.element': 'script', value: '// default\r\nanswer = 0;' },
                { document_key: id('2'), 'variable.element': 'script', value: 'answer = 60;' },
            ]]);
            const usage = await wm.getActivityUsage('Timer', { sampleSize: 3 });
            expect(usage).toMatchObject({ definitionName: 'Timer', publishedActivities: 42, sampled: 3 });
            expect(usage.fields).toEqual([
                { name: 'timer_type', setCount: 2, examples: [{ value: 'script', count: 2, isDefault: false }] },
                { name: 'script', setCount: 2, examples: [
                    { value: '// default\r\nanswer = 0;', count: 1, isDefault: true }, { value: 'answer = 60;', count: 1, isDefault: false }] },
            ]);
        });

        it('reads Activity Designer usage from the activities\' input JSON', async () => {
            routes.push(['wf_activity', /^activity_definition=dd/, [
                { sys_id: id('1'), input: '{"UserName":"${current.variables.user}","GroupName":"Admins","Extra":"x"}' },
                { sys_id: id('2'), input: '{"UserName":"${current.variables.user}"}' },
                { sys_id: id('3'), input: 'not json' },
            ]]);
            const usage = await wm.getActivityUsage(AD);
            expect(usage.fields.map(f => [f.name, f.setCount, f.examples[0]?.value])).toEqual([
                ['UserName', 2, '${current.variables.user}'], ['GroupName', 1, 'Admins'], ['Extra', 1, 'x']]);
        });
    });

    describe('exportWorkflow', () => {
        const IF_DEF = id('e');
        const CAT_DEF = id('f');
        const SUB_ACT = id('c');
        const GROUP = id('9').replace(/9/g, '2');
        const CATVAR = id('d').replace(/d/g, '3');

        beforeEach(() => {
            jest.spyOn(wm, 'getWorkflowDefinition').mockResolvedValue({
                workflowSysId: WF, versionSysId: PUBLISHED, name: 'My WF', table: 'sc_req_item', description: '', condition: '', conditionType: '',
                published: true, active: true, checkedOut: '', checkedOutBy: '', start: BEGIN, fullSequences: [BEGIN, END],
                stages: [{ sysId: 'st', name: 'Fulfilment', value: 'fulfilment', order: 1 }],
                activities: [
                    { sysId: BEGIN, name: 'Begin', definitionSysId: IF_DEF, definitionName: 'If', input: '', stage: 'st',
                        variables: { condition: `variables.${CATVAR}=true^EQ`, advanced: '0', empty: '' },
                        conditions: [{ sysId: ALWAYS, activitySysId: BEGIN, name: 'Yes', condition: "activity.result == 'yes'", order: 1,
                            elseFlag: false, error: false, event: false, eventName: '', shortDescription: '', skipDuringGenerate: false }] },
                    { sysId: SUB_ACT, name: 'Fulfil', definitionSysId: CAT_DEF, definitionName: 'Catalog Task', input: '{"UserName":"x"}',
                        variables: { task_fulfillment_group: GROUP, task_priority: '4' }, conditions: [] },
                ],
                transitions: [{ sysId: TRANSITION, from: BEGIN, to: SUB_ACT, condition: ALWAYS }],
            } as any);
            jest.spyOn(wm, 'getActivityDefinition').mockImplementation(async (ref: string) => (ref === IF_DEF
                ? { sysId: IF_DEF, name: 'If', category: 'Conditions', sysClassName: 'wf_activity_definition', description: 'Branches.', attributes: '',
                    defaultConditions: [], variables: [
                        { sysId: '1', model: 'm', element: 'condition', label: 'Condition', internalType: 'conditions', defaultValue: '', mandatory: false, order: 1 },
                        { sysId: '2', model: 'm', element: 'advanced', label: 'Advanced', internalType: 'boolean', defaultValue: 'false', mandatory: false, order: 2 }] }
                : { sysId: CAT_DEF, name: 'Catalog Task', category: 'Tasks', sysClassName: 'wf_activity_definition', description: '', attributes: 'generate=task',
                    defaultConditions: [], variables: [
                        { sysId: '3', model: 'm', element: 'task_fulfillment_group', label: 'Fulfillment group', internalType: 'reference', reference: 'sys_user_group', defaultValue: '', mandatory: false, order: 1 },
                        { sysId: '4', model: 'm', element: 'task_priority', label: 'Priority', internalType: 'string', defaultValue: '', mandatory: false, order: 2,
                            choices: [{ value: '4', label: '4 - Low' }] }] }) as any);
            routes.push(
                ['wf_workflow_version', `sys_id=${PUBLISHED}`, [{ sys_id: PUBLISHED, workflow: WF, name: 'My WF', published: 'true', active: 'true',
                    order: '100', run_multiple: 'false', after_business_rules: 'false', stage_field: 'stage', on_cancel: '// cancel', start: BEGIN }]],
                ['wf_workflow', 'name=My WF', [{ sys_id: WF, name: 'My WF', table: 'sc_req_item', description: '' }]],
                ['wf_workflow_version', /^workflowIN/, [{ sys_id: PUBLISHED, workflow: WF, published: 'true', active: 'true', checked_out_by: '' }]],
                ['wf_workflow', `sys_id=${WF}`, [{ sys_id: WF, name: 'My WF', table: 'sc_req_item', description: 'Does things', 'sys_scope.scope': 'global' }]],
                ['var_dictionary', `model_id=${WF}^ORDERBYorder`, [{ element: 'u_user', column_label: 'User', internal_type: 'reference', mandatory: 'true', default_value: '' }]],
                ['wf_workflow_instance', `workflow_version=${PUBLISHED}`, [{ activity: SUB_ACT, workflow: OTHER, 'workflow.name': 'Child' }]],
                ['sc_cat_item', `workflow=${WF}^ORDERBYname`, [{ sys_id: 'cat', name: 'Laptop', active: 'true' }]],
                ['wf_workflow_instance', `workflow=${WF}^workflow_version.published=true`, []],
                ['wf_activity_definition', `sys_id=${IF_DEF}`, [{ script: 'IfActivityHandler.prototype = Object.extendsObject(WFActivityHandler, {});' }]],
                ['wf_activity_definition', `sys_id=${CAT_DEF}`, [{ script: 'X.prototype = Object.extendsObject(Create_TaskActivityHandler, {});' }]],
                ['wf_activity_definition', 'js_class_name=Create_Task', [{ script: "if (activity.vars.wait_for_completion) executing.state = 'waiting';" }]],
                ['sys_user_group', `sys_idIN${GROUP}`, [{ sys_id: GROUP, name: 'Hardware Desk' }]],
                ['item_option_new', `sys_idIN${CATVAR}`, [{ sys_id: CATVAR, name: 'needs_laptop', question_text: 'Needs a laptop?' }]],
            );
        });

        it('exports the published version with labelled variables, references, waits, subflows and users', async () => {
            const exported = await wm.exportWorkflow('My WF');
            expect(exported).toMatchObject({
                format: 'now-sdk-ext/legacy-workflow@1',
                workflow: { sysId: WF, name: 'My WF', table: 'sc_req_item', description: 'Does things', scope: 'global' },
                version: { sysId: PUBLISHED, published: true, order: 100, stageField: 'stage', onCancel: '// cancel', start: BEGIN, fullSequences: [BEGIN, END] },
                inputs: [{ name: 'u_user', label: 'User', type: 'reference', mandatory: true, defaultValue: '' }],
                transitions: [{ sysId: TRANSITION, from: BEGIN, exit: ALWAYS, to: SUB_ACT }],
                usedBy: { catalogItems: [{ sysId: 'cat', name: 'Laptop', active: true }], parentWorkflows: [] },
            });
            expect(exported.activityTypes[IF_DEF]).toMatchObject({ name: 'If', waits: false, description: 'Branches.' });
            expect(exported.activityTypes[CAT_DEF]).toMatchObject({ name: 'Catalog Task', waits: true });
            const [begin, task] = exported.activities;
            expect(begin.variables).toEqual([
                { element: 'condition', label: 'Condition', type: 'conditions', value: `variables.${CATVAR}=true^EQ`, isDefault: false },
                { element: 'advanced', label: 'Advanced', type: 'boolean', value: '0', isDefault: true },
            ]);
            expect(begin.exits[0]).toMatchObject({ name: 'Yes', condition: "activity.result == 'yes'" });
            expect(task.variables).toEqual([
                { element: 'task_fulfillment_group', label: 'Fulfillment group', type: 'reference', value: GROUP, isDefault: false, display: 'Hardware Desk' },
                { element: 'task_priority', label: 'Priority', type: 'string', value: '4', isDefault: false, display: '4 - Low' },
            ]);
            expect(task.subflow).toEqual({ workflowSysId: OTHER, name: 'Child' });
            expect(task.input).toEqual({ UserName: 'x' });
            expect(exported.references).toEqual({
                [GROUP]: { table: 'sys_user_group', display: 'Hardware Desk' },
                [CATVAR]: { table: 'item_option_new', display: 'needs_laptop' },
            });
        });

        it('exports a version sys_id as given, and refuses a missing draft', async () => {
            await wm.exportWorkflow(PUBLISHED);
            expect(wm.getWorkflowDefinition).toHaveBeenCalledWith(PUBLISHED, { includeStatus: false });
            routes.unshift(['wf_workflow_version', `sys_id=My WF`, []]);
            await expect(wm.exportWorkflow('My WF', { version: 'draft' })).rejects.toThrow("Workflow 'My WF' has no draft version");
        });
    });

    describe('convertToFlow', () => {
        it('plans and writes the Fluent skeleton from the exported version', async () => {
            const data = buildExport({
                name: 'My WF', catalogItems: ['Laptop'],
                activities: [{ id: 'begin', type: 'Begin' }, { id: 'log', type: 'Log Message', vars: { message: 'hi' } }, { id: 'end', type: 'End' }],
                edges: [['begin', 'Always', 'log'], ['log', 'Always', 'end']],
            });
            const exportWorkflow = jest.spyOn(wm, 'exportWorkflow').mockResolvedValue(data);
            const result = await wm.convertToFlow('My WF', { version: 'published', directory: 'src/fluent/converted' });
            expect(exportWorkflow).toHaveBeenCalledWith('My WF', { version: 'published' });
            expect(result.export).toBe(data);
            expect(result.plan).toMatchObject({ kind: 'flow', identifier: 'my_wf', coverage: { direct: 1, partial: 0, manual: 0 } });
            expect(result.files.map(f => f.path)).toEqual(['src/fluent/converted/my-wf.now.ts']);
            expect(result.files[0].content).toContain('action.core.log');
        });
    });

    describe('activity types that wait', () => {
        it('reads the handler, not its comments', async () => {
            routes.push(['wf_activity_definition', `sys_id=${TIMER_DEF}`, [{ script: "// executing.state = 'waiting' in the old version\nX.prototype = Object.extendsObject(WFActivityHandler, {});" }]]);
            await expect((wm as any).typeWaits({ sysId: TIMER_DEF, sysClassName: 'wf_activity_definition' })).resolves.toBe(false);
        });
    });

    describe('validateWorkflow', () => {
        it('runs the report page, then reads the results', async () => {
            const req = { get: jest.fn<any>().mockResolvedValue({
                data: '<div id="wf_validation_summary_message"><h4>Validate Summary  - Valid Workflow - Total checks performed:16 (Info:16, Warn:0, Critical:0)</h4></div>' }) };
            jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
            routes.push(['v_wf_validation_report', `workflow_version=${DRAFT}`, [{ type: 'ValidateSingleEnd', level: 'Info', message: 'ok', details: '' }]]);

            await expect(wm.validateWorkflow(DRAFT)).resolves.toEqual({
                versionSysId: DRAFT, valid: true,
                summary: 'Validate Summary - Valid Workflow - Total checks performed:16 (Info:16, Warn:0, Critical:0)',
                items: [{ type: 'ValidateSingleEnd', level: 'Info', message: 'ok', details: '' }],
            });
            expect(req.get.mock.calls[0][0]).toMatchObject({ path: '/validate_workflow.do', query: { sysparm_sys_id: DRAFT }, requires: READ_ONLY });
        });

        it('does not pass off an earlier run as this one when the report page did not render', async () => {
            const req = { get: jest.fn<any>().mockResolvedValue({ status: 200, data: '<html>login</html>' }) };
            jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
            routes.push(['v_wf_validation_report', `workflow_version=${DRAFT}`, [{ type: 'Old', level: 'Warn', message: 'old', details: '' }]]);
            await expect(wm.validateWorkflow(DRAFT)).rejects.toThrow(`Could not run the validation for workflow version ${DRAFT} (status 200)`);
            expect(read).not.toHaveBeenCalledWith('v_wf_validation_report', expect.anything(), expect.anything(), expect.anything());
        });
    });
});
