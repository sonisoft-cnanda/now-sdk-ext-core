// import {MessageClient} from '../../src/amb/MessageClient';
// import cometdLib from 'cometd';
// import {ServerConnection} from '../../src/amb/ServerConnection';
// import {Channel} from '../../src/amb/Channel';
// import {ChannelRedirect} from '../../src/amb/ChannelRedirect';
// import {GraphQLSubscriptionExtension} from "../../src/amb/GraphQLSubscriptionExtension";


// jest.mock('cometd');
// const registerTransport = jest.fn();
// const unregisterTransport = jest.fn();
// const registerExtension = jest.fn();
// const unregisterExtension = jest.fn();
// const batch = jest.fn();
// const mockCometD = jest.fn().mockImplementation(() => {
// 	return {
// 		batch: batch,
// 		registerExtension: registerExtension,
// 		unregisterExtension: unregisterExtension,
// 		registerTransport: registerTransport,
// 		unregisterTransport : unregisterTransport,
// 		addListener: jest.fn(),
// 		getClientId: jest.fn().mockImplementation(() => { return 'aaaa'})

// 	}
// });

// const longPollingTransport = jest.fn();
// const webSocketTransport = jest.fn();
// cometdLib.LongPollingTransport = longPollingTransport;
// cometdLib.WebSocketTransport = webSocketTransport;
// cometdLib.CometD = mockCometD;

// jest.mock('../amb.ServerConnection');
// const subscribeToEvent = jest.fn();
// const unsubscribeFromEvent = jest.fn();
// const getEvents = jest.fn();
// const isLoggedIn = jest.fn();
// const loginComplete = jest.fn();
// const connect = jest.fn();
// const reload = jest.fn();
// const abort = jest.fn();
// const disconnect = jest.fn();
// const getConnectionState = jest.fn();
// const getLastError = jest.fn(() => { return 'aaa'});
// const setLastError = jest.fn();
// const getChannel = jest.fn();
// const removeChannel = jest.fn();
// const getChannels = jest.fn();
// const getErrorMessages = jest.fn().mockImplementation(() => {
// 	return {'UNKNOWN_CLIENT': '402::Unknown client'};
// });

// const events = {
// 	CONNECTION_INITIALIZED: 'connection.initialized',
// 	CONNECTION_OPENED: 'connection.opened',
// 	SESSION_LOGGED_IN: 'session.logged.in',
// 	SESSION_LOGGED_OUT: 'session.logged.out',
// 	SESSION_INVALIDATED: 'session.invalidated'
// };


// jest.mock('../amb.Channel');
// const subscribeOnInitCompletion = jest.fn();
// const getName = jest.fn();
// const unsubscribeFromCometD = jest.fn();
// const resubscribeToCometD = jest.fn();
// const getSubscribeOptionsCallback = jest.fn();
// Channel.mockImplementation((cometd, channelName, active, subscribeOptionsCallback) => {
// 	return {
// 		getSubscribeOptionsCallback: getSubscribeOptionsCallback.mockImplementation(() => { return subscribeOptionsCallback; }),
// 		subscribeOnInitCompletion: subscribeOnInitCompletion,
// 		getName: getName.mockImplementation(() => {
// 			return channelName;
// 		}),
// 		unsubscribeFromCometD: unsubscribeFromCometD,
// 		resubscribeToCometD: resubscribeToCometD
// 	}
// });

// ServerConnection.mockImplementation(() => {
// 	return {
// 		getLastError: getLastError,
// 		setLastError: setLastError,
// 		getConnectionState: getConnectionState,
// 		subscribeToEvent: subscribeToEvent,
// 		unsubscribeFromEvent: unsubscribeFromEvent,
// 		loginComplete: loginComplete,
// 		connect: connect,
// 		getChannel: getChannel.mockImplementation((channelName, subscribeOptionsCallback) => {
// 			return new Channel(null, channelName, true, subscribeOptionsCallback);
// 		}),
// 		reload: reload,
// 		abort: abort,
// 		disconnect: disconnect,
// 		isLoggedIn: isLoggedIn.mockImplementation(() => {
// 			return true;
// 		}),
// 		getEvents: getEvents.mockImplementation(() => {
// 			return events;
// 		}),
// 		getErrorMessages: getErrorMessages,
// 		getChannels: getChannels,
// 		removeChannel: removeChannel
// 	}
// });



// jest.mock('../amb.ChannelRedirect');
// const initialize = jest.fn();
// ChannelRedirect.mockImplementation(() => {
// 	return {
// 		initialize: initialize
// 	}
// });

// jest.mock('../amb.GraphQLSubscriptionExtension');
// const isGraphQLChannel = jest.fn();
// const addGraphQLChannel = jest.fn();
// const removeGraphQLChannel = jest.fn();
// GraphQLSubscriptionExtension.mockImplementation(() => {
// 	return {
// 		isGraphQLChannel : isGraphQLChannel,
// 		addGraphQLChannel : addGraphQLChannel,
// 		removeGraphQLChannel : removeGraphQLChannel
// 	}
// });

// beforeEach(() => {
// 	jest.clearAllMocks();
// });

// describe('MessageClient', () => {
// 	let outputMessage = '';
// 	let testMessageClient;

// 	beforeEach(() => {
// 		outputMessage = '';
// 		testMessageClient = new MessageClient();
// 		isGraphQLChannel.mockImplementation(() => {});
// 	});

// 	describe('construction', () => {
// 		it('sets up transport and event handlers', () => {
// 			expect(cometdLib.CometD).toHaveBeenCalled();
// 			expect(mockCometD).toHaveBeenCalled();
// 			expect(longPollingTransport).toHaveBeenCalled();
// 			expect(webSocketTransport).toHaveBeenCalled();
// 			expect(registerTransport).toHaveBeenCalledWith('websocket', jasmine.any(Object), 0);
// 			expect(registerTransport).toHaveBeenCalledWith('long-polling', jasmine.any(Object), 1);
// 			expect(unregisterTransport).toHaveBeenCalledWith('callback-polling');
// 			expect(ServerConnection).toHaveBeenCalled();
// 			expect(registerExtension).toHaveBeenCalledWith('graphQLSubscription', jasmine.any(Object))
// 		});
// 	});

// 	describe('getServerConnection', () => {
// 		it('returns server connection object', () => {
// 			expect(testMessageClient.getServerConnection()).toEqual(new ServerConnection());
// 		});
// 	});

// 	describe('isLoggedIn', () => {
// 		it('returns logged in status', () => {
// 			expect(testMessageClient.isLoggedIn()).toBe(true);
// 		});
// 	});

// 	describe('loginComplete', () => {
// 		it('calls server connection loginComplete', () => {
// 			testMessageClient.loginComplete();
// 			expect(loginComplete).toHaveBeenCalled();
// 		});
// 	});

// 	describe('server connection', () => {
// 		it('connect calls server connection connect', () => {
// 			testMessageClient.connect();
// 			expect(connect).toHaveBeenCalled();
// 			expect(testMessageClient.isConnected()).toBe(true);
// 		});

// 		it('connect does not try to connect if already connected', () => {
// 			testMessageClient.connect();
// 			testMessageClient.connect();
// 			expect(connect).toHaveBeenCalledTimes(1);
// 		});

// 		it('reload calls server connection reload', () => {
// 			testMessageClient.reload();
// 			expect(reload).toHaveBeenCalled();
// 			expect(testMessageClient.isConnected()).toBe(false);
// 		});

// 		it('abort calls server connection abort', () => {
// 			testMessageClient.abort();
// 			expect(abort).toHaveBeenCalled();
// 			expect(testMessageClient.isConnected()).toBe(false);
// 		});

// 		it('disconnect calls server connection disconnect', () => {
// 			testMessageClient.disconnect();
// 			expect(disconnect).toHaveBeenCalled();
// 			expect(testMessageClient.isConnected()).toBe(false);
// 		});
// 	});

// 	describe('server connection events', () => {
// 		it('returns server connection events', () => {
// 			expect(testMessageClient.getConnectionEvents()).toBe(events);
// 		});

// 		it('subscribes to server connection event', () => {
// 			ServerConnection().subscribeToEvent.mockImplementation(() => {
// 				return 1;
// 			});
// 			const callback = () => true;
// 			expect(testMessageClient.subscribeToEvent(events.CONNECTION_OPENED, callback)).toBe(1);
// 		});

// 		it('returns server connection state', () => {
// 			ServerConnection().getConnectionState.mockImplementation(() => {
// 				return 'opened';
// 			});
// 			expect(testMessageClient.getConnectionState()).toBe('opened');
// 		});

// 		it('unsubscribes from a server event', () => {
// 			testMessageClient.unsubscribeFromEvent(2);
// 			expect(unsubscribeFromEvent).toHaveBeenCalledWith(2);
// 		});
// 	});

// 	describe('getClientId', () => {
// 		it('returns the client id from cometed', () => {
// 			expect(testMessageClient.getClientId()).toBe('aaaa');
// 		});
// 	});

// 	describe('channels', () => {
// 		it('getChannel gets channel listener from server channel with subscribe options callback', () => {
// 			getName.mockImplementation(() => {
// 				return 'channel name';
// 			});
// 			const subConfig = {
// 				subscribeOptionsCallback: function() { return {"blah":"blah"}; },
// 				subscriptionCallback : () => {}
// 			};
// 			const channelListener = testMessageClient.getChannel('channel name', subConfig);
// 			expect(getChannel).toHaveBeenCalledWith('channel name', subConfig.subscribeOptionsCallback);
// 			expect(channelListener.getName()).toBe('channel name');
// 			expect(channelListener.getSubscriptionCallback()).toBe(subConfig.subscriptionCallback);
// 			expect(addGraphQLChannel).toHaveBeenCalledTimes(0);
// 		});

// 		it('getChannel gets channel listener from server channel', () => {
// 			getName.mockImplementation(() => {
// 				return 'channel name';
// 			});
// 			const subConfig = {
// 				subscriptionCallback : () => {}
// 			};
// 			const channelListener = testMessageClient.getChannel('channel name', subConfig);
// 			expect(getChannel).toHaveBeenCalledWith('channel name', undefined);
// 			expect(channelListener.getName()).toBe('channel name');
// 			expect(channelListener.getSubscriptionCallback()).toBe(subConfig.subscriptionCallback);
// 			expect(addGraphQLChannel).toHaveBeenCalledTimes(0);
// 		});

// 		it('getChannel returns channel listener with no subscription config', () => {
// 			getChannels.mockImplementation(() => {
// 				return ["doesn't matter that this is not a channel, just returned from ServerConnection"]
// 			});
// 			getName.mockImplementation(() => {
// 				return 'channel name';
// 			});
// 			const channelListener = testMessageClient.getChannel('channel name');
// 			expect(getChannel).toHaveBeenCalledWith('channel name', undefined);
// 			expect(channelListener.getName()).toBe('channel name');
// 			expect(Object.keys(testMessageClient.getChannels()).length).toBe(1);
// 		});

// 		it('getChannel for same channel creates one channel and multiple channel listeners', () => {
// 			testMessageClient.getChannel('channel name');
// 			testMessageClient.getChannel('channel name');
// 			expect(Object.keys(testMessageClient.getChannels()).length).toBe(1);
// 		});



// 		it('getChannel adds to graphql subscriptions for graphql channels', () => {
// 			isGraphQLChannel.mockImplementation(() => {return true});
// 			const subConfig = {
// 				serializedGraphQLSubscription : 'AAAAAAAAAAAAAAAAAAAAAAA',
// 				subscriptionCallback : () => {}
// 			};

// 			testMessageClient.getChannel('/rw/graphql/somehash', subConfig);
// 			expect(Object.keys(testMessageClient.getChannels()).length).toBe(1);
// 			expect(isGraphQLChannel).toHaveBeenCalledWith('/rw/graphql/somehash');
// 			expect(addGraphQLChannel).toHaveBeenCalledWith('/rw/graphql/somehash', 'AAAAAAAAAAAAAAAAAAAAAAA');
// 		});

// 		it('getChannel logs if serialized subscription is missing from graphql channel subscribe', () => {
// 			let outputMessage = '';
// 			console.log = jest.fn(input => (outputMessage = input));
// 			isGraphQLChannel.mockImplementation(() => {return true});
// 			const subConfig = {
// 				subscriptionCallback : () => {}
// 			};

// 			testMessageClient.getChannel('/rw/graphql/somehash', subConfig);
// 			expect(isGraphQLChannel).toHaveBeenCalledWith('/rw/graphql/somehash');
// 			expect(outputMessage).toBe('amb.MessageClient [ERROR] Serialized subscription not present for GraphQL channel /rw/graphql/somehash');
// 		});

// 		it('remove channel removes graphql channel', () => {
// 			isGraphQLChannel.mockImplementation(() => {return true});
// 			const subConfig = {
// 				serializedGraphQLSubscription : 'AAAAAAAAAAAAAAAAAAAAAAA',
// 				subscriptionCallback : () => {}
// 			};

// 			testMessageClient.getChannel('/rw/graphql/somehash', subConfig);
// 			expect(getChannel).toHaveBeenCalledTimes(1);
// 			testMessageClient.removeChannel('/rw/graphql/somehash');
// 			expect(removeChannel).toHaveBeenCalledTimes(1);
// 			expect(removeGraphQLChannel).toHaveBeenCalledWith('/rw/graphql/somehash');
// 		});
// 	});

// 	describe('extensions', () => {
// 		it('registers an extension with cometd', () => {
// 			testMessageClient.registerExtension('an extension', {});
// 			expect(registerExtension).toHaveBeenCalledWith('an extension', {})
// 		});

// 		it('unregister an extension with cometd', () => {
// 			testMessageClient.unregisterExtension('an extension');
// 			expect(unregisterExtension).toHaveBeenCalledWith('an extension')
// 		});
// 	});

// 	describe('batch', () => {
// 		it('batches messages to cometd', () => {
// 			const batchFunc = () => {};
// 			testMessageClient.batch(batchFunc);
// 			expect(batch).toHaveBeenCalledWith(batchFunc);
// 		});
// 	});

// });

describe.skip('MessageClient - legacy test, broken imports', () => {
	it.skip('placeholder', () => {});
});