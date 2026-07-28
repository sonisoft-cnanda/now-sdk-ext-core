



import { adapt } from "../../../src/sn/amb/cometd-nodejs-client";
import { SubscriptionConfig } from "../../../src/sn/amb/MessageClient";

import { MessageClientBuilder } from "../../../src/sn/amb/MessageClientBuilder";
import { Logger } from "../../../src/util/Logger";
import { JSDOM } from 'jsdom'
import { AMBClient } from "../../../src/sn/amb/AMBClient";
import { ServiceNowInstance, ServiceNowSettingsInstance } from "../../../src/sn/ServiceNowInstance";
import { getCredentials } from "@servicenow/sdk-cli/dist/auth/index.js";
import { TableAPIRequest } from "../../../src/comm/http/TableAPIRequest";
import { SN_INSTANCE_ALIAS } from '../../test_utils/test_config';

const { window } = new JSDOM();


describe.skip('AMBClient', () => {
    let instance: ServiceNowInstance;
    let credential: unknown;
    const SECONDS = 1000;
   
    beforeEach(async () => {
        credential = await getCredentials(SN_INSTANCE_ALIAS);
        
        if (credential) {
            const snSettings: ServiceNowSettingsInstance = {
                alias: SN_INSTANCE_ALIAS,
                credential: credential
            };
            instance = new ServiceNowInstance(snSettings);
        }
    });

    describe('execute test', () => {
       

        it('can run client', async () => {
            const logger = new Logger('AMBClient.test');
            
            // Initialize window FIRST (CometD needs it)
            const windowOptions: any = { cookies: null };
            const window:any = adapt(windowOptions);
            global.window = window;
            
            const mb:MessageClientBuilder = new MessageClientBuilder();
            const clientSubscriptions = mb.buildClientSubscriptions();
            
            // Pass ServiceNowInstance to AMBClient
            const client:AMBClient = new AMBClient(clientSubscriptions, instance);
            
            // Authenticate first to get session cookies
            console.log('\n🔐 Authenticating...');
            await client.authenticate();
            console.log('✅ Authentication complete\n');
            
            // Get the cookies that were set and update window options
            const serverConn: any = client.getServerConnection();
            const cookies = serverConn._sessionCookies;
            console.log('📋 Cookies obtained:', cookies ? `${cookies.substring(0, 80)}...` : 'none');
            
            // Update window options with cookies for WebSocket
            if (window._wsOptions && cookies) {
                window._wsOptions.cookies = cookies;
                console.log('✅ WebSocket configured with cookies\n');
            }

            // Now connect to AMB with authenticated WebSocket
            console.log('🔌 Connecting to AMB...');
            client.connect();

            // Wait for connection to establish
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log('✅ AMB Connected\n');
            console.log('📡 Setting up Record Watcher...\n');

            //expect(client._serverConnection.connected).toBe(true);
            const subConfig:SubscriptionConfig = {};
            subConfig.subscriptionCallback = function(message:any){
                console.log('\n🎉 RECEIVED MESSAGE via subscriptionCallback!');
                console.log(JSON.stringify(message, null, 2));
                logger.debug("subscriptionCallback", message);
            }

            subConfig.subscribeOptionsCallback = function(){
                console.log('✅ Subscription options callback triggered');
                logger.debug("subscribeOptionsCallback");
            }



            const rwChannel = client.getRecordWatcherChannel("incident", 'active=true', null, subConfig);
            console.log('📋 Record Watcher Channel Created:', rwChannel.getName());

            let messageReceived = false;
            rwChannel.subscribe(function(message){
                console.log('\n🎉 RECEIVED MESSAGE via channel subscribe callback!');
                console.log(JSON.stringify(message, null, 2));
                logger.debug("Channel subscription callback", message);
                messageReceived = true;
            });

            console.log('\n👀 Subscription active, now creating a incident entry programmatically...\n');
            
            // Wait a moment for subscription to fully establish
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Create a syslog entry programmatically using Table API
            const tableAPI = new TableAPIRequest(instance);
            const incidentBody = {
                active: true,  // Matches the filter in RecordWatcher
                short_description: 'AMBClient.test.ts',
                description: 'Test syslog entry created by automated test at ' + new Date().toISOString()
            };

            console.log('📝 Creating syslog entry with active=true...');
            const createResponse = await tableAPI.post('incident', {}, JSON.stringify(incidentBody) as any);
            
            if (createResponse.status === 201 || createResponse.status === 200) {
                console.log('✅ Incident entry created successfully');
                console.log('   Response:', JSON.stringify(createResponse.bodyObject, null, 2));
            } else {
                console.log('⚠️  Unexpected response status:', createResponse.status);
            }

            console.log('\n⏳ Waiting for AMB message (2 seconds)...\n');
            
            // Wait for message to be received via AMB
            await new Promise(resolve => setTimeout(resolve, 2000));

            console.log('\n⏹️  Test complete, disconnecting...');
            console.log(`   Message received: ${messageReceived ? '✅ YES' : '❌ NO'}`);
            client.disconnect();

            // Verify that we received a message
            expect(messageReceived).toBe(true);
        }, 60 * SECONDS)


        
    })
})