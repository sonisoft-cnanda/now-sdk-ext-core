/**
 * Integration tests for ScriptTracer against a live ServiceNow instance.
 * Requires alias configured via SN CLI (default: dev224436).
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { adapt } from '../../../../src/sn/amb/cometd-nodejs-client';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { ScriptTracer } from '../../../../src/sn/scripttracer/ScriptTracer';
import { AMBClient } from '../../../../src/sn/amb/AMBClient';
import { MessageClientBuilder } from '../../../../src/sn/amb/MessageClientBuilder';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { TraceStatement } from '../../../../src/sn/scripttracer/ScriptTracerModels';
import { HTTPRequest } from '../../../../src/comm/http/HTTPRequest';
import { getCredentials } from '@servicenow/sdk-cli/dist/auth/index.js';
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';

const TIMEOUT = 90000;

describe('ScriptTracer Integration', () => {
    let instance: ServiceNowInstance;
    let ambClient: AMBClient;
    let tracer: ScriptTracer;

    beforeAll(async () => {
        // CometD window adapter for WebSocket transport
        const windowOptions: any = { cookies: null };
        const ambWindow: any = adapt(windowOptions);
        global.window = ambWindow;

        // Create ServiceNow instance
        const credential = await getCredentials(SN_INSTANCE_ALIAS);
        const settings: ServiceNowSettingsInstance = { alias: SN_INSTANCE_ALIAS, credential };
        instance = new ServiceNowInstance(settings);

        // Build and authenticate AMB client
        const mb = new MessageClientBuilder();
        const clientSubscriptions = mb.buildClientSubscriptions();
        ambClient = new AMBClient(clientSubscriptions, instance);

        console.log('Authenticating...');
        await ambClient.authenticate();

        // Forward cookies to WebSocket
        const serverConn: any = ambClient.getServerConnection();
        const cookies = serverConn.getSessionCookies();
        console.log('Cookies:', cookies?.substring(0, 100));

        if (ambWindow._wsOptions && cookies) {
            ambWindow._wsOptions.cookies = cookies;
        }

        // Connect AMB and wait for connection
        console.log('Connecting to AMB...');
        ambClient.connect();
        await new Promise(resolve => setTimeout(resolve, 3000));
        console.log('AMB state:', ambClient.getConnectionState());
    }, TIMEOUT);

    afterAll(async () => {
        if (tracer && tracer.state === 'tracing') {
            await tracer.stop();
        }
        if (ambClient) {
            ambClient.disconnect();
        }
    });

    it('starts and stops tracer with correct session ID from debugger/start', async () => {
        tracer = new ScriptTracer(ambClient, instance);
        const startResult = await tracer.start();
        console.log('Start result:', startResult);

        expect(startResult.success).toBe(true);
        expect(startResult.sessionId).toBeDefined();
        expect(startResult.sessionId!.length).toBe(32);
        expect(tracer.state).toBe('tracing');

        const stopResult = await tracer.stop();
        expect(stopResult.success).toBe(true);
        expect(tracer.state).toBe('stopped');
    }, TIMEOUT);

    it('receives trace data when triggering a processor request', async () => {
        const receivedStatements: TraceStatement[] = [];

        tracer = new ScriptTracer(ambClient, instance, {
            onTrace: (statements) => {
                console.log(`[onTrace] ${statements.length} statements, first: ${statements[0]?.fileTypeLabel} - ${statements[0]?.fileName}`);
                receivedStatements.push(...statements);
            },
        });

        const startResult = await tracer.start();
        expect(startResult.success).toBe(true);
        console.log(`Tracer started, sessionId: ${startResult.sessionId}`);

        // Wait for subscriptions to establish
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Use a processor request (.do URL) instead of REST API
        // The script tracer captures .do processor transactions, not REST API
        const snRequest = SessionManager.getInstance().getRequest(instance);
        const processorReq: HTTPRequest = {
            path: '/incident_list.do',
            method: 'get',
            headers: { 'Accept': 'text/html' },
            query: { sysparm_limit: '1', sysparm_query: 'active=true' },
            body: null,
        };
        console.log('Making processor request to /incident_list.do...');
        const resp = await snRequest.get(processorReq);
        console.log('Processor request status:', resp.status);

        // Wait for AMB messages
        console.log('Waiting for trace data (15s)...');
        await new Promise(resolve => setTimeout(resolve, 15000));

        console.log(`Total trace statements received: ${receivedStatements.length}`);
        if (receivedStatements.length > 0) {
            console.log('First statement:', JSON.stringify(receivedStatements[0], null, 2));
        } else {
            console.log('No trace statements received — AMB channel may not be delivering messages');
        }

        await tracer.stop();

        expect(receivedStatements.length).toBeGreaterThan(0);
    }, TIMEOUT);

    it('SessionManager returns same request for same alias', () => {
        const req1 = SessionManager.getInstance().getRequest(instance);
        const req2 = SessionManager.getInstance().getRequest(instance);
        expect(req1).toBe(req2);
    });
});
