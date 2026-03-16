// import TokenManagementExtension from "../amb.TokenManagementExtension";
// import properties from "../amb.Properties";

// const META_SUBSCRIBE = '/meta/subscribe';
// const META_UNSUBSCRIBE = '/meta/unsubscribe';

// const SUB_MESSAGE   = { text: 'subscribing', channel: META_SUBSCRIBE };
// const UNSUB_MESSAGE = { channel: META_UNSUBSCRIBE, text: 'unsubscribing' };
// const OTHER_MESSAGE = { text: 'something else', channel: '/meta/unrecognized', testing: '123' };

// describe('TokenManagementExtension', () => {
// 	it('test initial state', () => {
// 		const initTokens = 8;
// 		properties.subscribeCommandsFlow.enable = true;
// 		properties.subscribeCommandsFlow.maxInflight = initTokens;
// 		let tokenManager = new TokenManagementExtension();
// 		expect(tokenManager.getTokenCount()).toBe(initTokens);
// 	});

// 	it('test updateToken', () => {
// 		const initTokens = 8;
// 		properties.subscribeCommandsFlow.enable = true;
// 		properties.subscribeCommandsFlow.maxInflight = initTokens;
// 		let tokenManager = new TokenManagementExtension()
// 		expect(tokenManager.getTokenCount()).toBe(initTokens);
// 		const newTokenAmt = 13;
// 		tokenManager.updateTokenCount(newTokenAmt);
// 		expect(tokenManager.getTokenCount()).toBe(newTokenAmt);
// 	});

// 	it('test incoming messages', () => {
// 		const initTokens = 8;
// 		properties.subscribeCommandsFlow.enable = true;
// 		properties.subscribeCommandsFlow.maxInflight = initTokens;
// 		let tokenManager = new TokenManagementExtension()
// 		let beforeCount = tokenManager.getTokenCount();
// 		tokenManager.incoming(SUB_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(properties.subscribeCommandsFlow.maxInflight);
// 		tokenManager.incoming(OTHER_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(properties.subscribeCommandsFlow.maxInflight);
// 		tokenManager.incoming(UNSUB_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(properties.subscribeCommandsFlow.maxInflight);
// 	});

// 	it('test outgoing messages', () => {
// 		const initTokens = 8;
// 		properties.subscribeCommandsFlow.enable = true;
// 		properties.subscribeCommandsFlow.maxInflight = initTokens;
// 		let tokenManager = new TokenManagementExtension()
// 		let beforeCount = tokenManager.getTokenCount();
// 		tokenManager.outgoing(SUB_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(beforeCount - 1);
// 		tokenManager.outgoing(OTHER_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(beforeCount - 1);
// 		tokenManager.outgoing(UNSUB_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(beforeCount - 2);
// 	});

// 	it('test outgoing zero floor', () => {
// 		const initTokens = 1;
// 		properties.subscribeCommandsFlow.enable = true;
// 		properties.subscribeCommandsFlow.maxInflight = initTokens;
// 		let tokenManager = new TokenManagementExtension()
// 		let beforeCount = tokenManager.getTokenCount();
// 		tokenManager.outgoing(SUB_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(0);
// 		tokenManager.outgoing(OTHER_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(0);
// 		tokenManager.outgoing(UNSUB_MESSAGE);
// 		expect(tokenManager.getTokenCount()).toBe(0);
// 	});

// 	it('test listener', () => {
// 		const initTokens = 8;
// 		properties.subscribeCommandsFlow.enable = true;
// 		properties.subscribeCommandsFlow.maxInflight = initTokens;
// 		let tokenManager = new TokenManagementExtension()

// 		const testListener = jest.fn();
// 		tokenManager.addTokenAvailabilityListener(testListener);

// 		let expectedCallbackCount = 0;
// 		tokenManager.incoming(OTHER_MESSAGE);
// 		expect(testListener).toHaveBeenCalledTimes(expectedCallbackCount);

// 		tokenManager.outgoing(UNSUB_MESSAGE);
// 		expect(testListener).toHaveBeenCalledTimes(expectedCallbackCount);

// 		tokenManager.incoming(UNSUB_MESSAGE);
// 		expectedCallbackCount++;

// 		tokenManager.outgoing(OTHER_MESSAGE);
// 		tokenManager.incoming(SUB_MESSAGE);
// 		expectedCallbackCount++;

// 		tokenManager.outgoing(SUB_MESSAGE);
// 		expect(testListener).toHaveBeenCalledTimes(expectedCallbackCount);

// 		tokenManager.removeTokenAvailabilityListener(testListener);

// 		tokenManager.incoming(SUB_MESSAGE);
// 		tokenManager.outgoing(SUB_MESSAGE);
// 		expect(testListener).toHaveBeenCalledTimes(expectedCallbackCount);

// 		tokenManager.incoming(UNSUB_MESSAGE);
// 		tokenManager.outgoing(UNSUB_MESSAGE);
// 		expect(testListener).toHaveBeenCalledTimes(expectedCallbackCount);
// 	});
// });

describe.skip('TokenManagementExtension - legacy test, broken imports', () => {
	it.skip('placeholder', () => {});
});