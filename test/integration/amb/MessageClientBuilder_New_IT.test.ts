// import amb from "./amb.js"
// import { adapt } from "cometd-nodejs-client";
// import Logger from "../../../build/src/sn/amb/Logger"
// const LOGGER = new Logger('index');

import { AMBClient } from "../../../src/sn/amb/AMBClient";
import { MessageClientBuilder } from "../../../src/sn/amb/MessageClientBuilder"



describe.skip('MessageClientBuilder', () => {
   
    describe('execute test', () => {
       

        xit('should return client', async () => {
            let builder:MessageClientBuilder = new MessageClientBuilder();
            let client:AMBClient = builder.createClient();
        })
    })
})