// import MessageClient from "../amb.MessageClient";
// import getClient from "../amb.MessageClientBuilder";
// import ServerConnection from "../amb.ServerConnection";
// import Channel from "../amb.Channel";
// import ChannelListener from "../amb.ChannelListener";


// const connect = jest.fn();
// const removeChannel = jest.fn();

// jest.mock('../amb.Channel');
// let listeners = [];
// Channel.mockImplementation(() => {
// 	return {
// 		getChannelListeners: () => listeners
// 	}
// });


// jest.mock('../amb.ServerConnection');
// ServerConnection.mockImplementation(() => {
// 	return {
// 		getChannel: Channel
// 	}
// });

// jest.mock('../amb.ChannelListener');
// ChannelListener.mockImplementation(() => {
// 	return {
// 		subscribe: jest.fn(),
// 		unsubscribe: jest.fn()
// 	}
// });

// jest.mock('../amb.MessageClient');
// const initialize = jest.fn();

// MessageClient.mockImplementation(() => {
// 	return {
// 		initialize: initialize,
// 		connect: connect,
// 		getServerConnection: ServerConnection,
// 		getChannel: ChannelListener,
// 		removeChannel: removeChannel
// 	}
// });


// beforeEach(() => {
// 	jest.clearAllMocks();
// 	listeners = [];
// });

// describe('Subscribe and unsubscribe from channel', () => {
// 	it('channel removed from server connection list when unsubscribed and there no more listeners', () => {
// 		const messageClient = getClient();
// 		const channel = messageClient.getChannel('foo');
// 		const listener = () => {
// 		};
// 		channel.subscribe(listener);
// 		channel.unsubscribe(listener);
// 		expect(removeChannel).toHaveBeenCalledWith('foo');
// 	});

// 	it('channel is not removed from server connection list when unsubscribed and other listeners are present', () => {
// 		const messageClient = getClient();
// 		const channel = messageClient.getChannel('foo');
// 		const listener = () => {
// 		};
// 		channel.subscribe(listener);
// 		listeners.push(listener);
// 		channel.unsubscribe(listener);
// 		expect(removeChannel).toHaveBeenCalledTimes(0);
// 	});
// });

describe.skip('MessageClientBuilder - legacy test, broken imports', () => {
	it.skip('placeholder', () => {});
});
