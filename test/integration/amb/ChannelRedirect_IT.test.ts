
import { mock } from "ts-jest-mocker";
import {ChannelListener} from '../../../src/sn/amb/ChannelListener';
import {ChannelRedirect} from '../../../src/sn/amb/ChannelRedirect';
import {Channel} from "../../../src/sn/amb/Channel";
import {ServerConnection} from "../../../src/sn/amb/ServerConnection";
import { CometD } from "cometd";


let channels:any = {};

let testChannelRedirect;
describe.skip('ChannelRedirect', () => {
	let mockChannel:any = null;
	let mockChannelListener:any = null;
	let mockServerConnection:any =null;
	let mockCometD:any = null;
	
	

	beforeEach(() => {
		channels = {};
		mockChannelListener = getMockChannelListener();

		mockCometD = mock(CometD);
		mockCometD.getClientId.mockReturnValue('cometDClientId');

		mockChannel = mock(Channel);
		//mockChannel.getClientId.mockReturnValue('cometDClientId');
		mockChannel.getChannelListeners.mockImplementation(() => {
			let arr:any = [
				 mockChannelListener, mockChannelListener
			];
			return arr; //[new ChannelListener(null, null, null)];
		});
		mockChannel.subscribe.mockImplementation(() => {

		});
		//mockChannel.getName.mockReturnValue("")

	 	
		mockServerConnection = getMockServerConnection();

		//channelListenerSubscribe = jest.fn();
	});

	function getMockChannelListener(){
		let mockL:any = mock(ChannelListener);
		mockL.setNewChannel.mockImplementation((newChannel) => {});
		mockL.subscribe.mockImplementation(() => {

		});

		return mockL;
	}

	function getMockServerConnection(){
		let mockSrvConn = mock(ServerConnection);

	 	
		mockSrvConn.getChannel.mockImplementation((channelName) => {
			if (channelName in channels)
				return channels[channelName];

			const channel = getMockChannel(channelName);//new Channel(mockServerConnection, mockCometD, channelName, false);
			channels[channelName] = channel;
			return channel;
		});

		mockSrvConn.removeChannel.mockImplementation((channelName) => {
			delete channels[channelName];
		});
		return mockSrvConn;
	}

	function getMockChannel(channelName){
		let channelMock = mock(Channel);
		channelMock.getName.mockReturnValue(channelName);


		return channelMock;
	}

	describe('initialize', () => {
		it('initializes channel redirect listener', () => {
			const testChannelRedirect = new ChannelRedirect(mockCometD, mockServerConnection);
			testChannelRedirect.initialize(() => {});

			expect(mockServerConnection.getChannel).toHaveBeenCalledWith('/sn/meta/channel_redirect/cometDClientId')
		});

		xit('calls resubscribe if already initialized', () => {
			// getChannelListeners = jest.fn().mockImplementation(() => {
			// 	let arr:any = [
			// 		 new ChannelListener(mockChannel, mockServerConnection, null)
			// 	];
			// 	return arr; //[new ChannelListener(null, null, null)];
			// });
			const testChannelRedirect = new ChannelRedirect(mockCometD, mockServerConnection);

			// expect(channelSubscribe).toHaveBeenCalledTimes(0);
			// expect(subscribeToCometD).toHaveBeenCalledTimes(0);
			// expect(channelListenerSubscribe).toHaveBeenCalledTimes(0);

			// testChannelRedirect.initialize();
			// expect(channelListenerSubscribe).toHaveBeenCalledTimes(1);
			// expect(mockServerConnection.getChannel).toHaveBeenCalledTimes(1);
			// expect(subscribeToCometD).toHaveBeenCalledTimes(0);

			// testChannelRedirect.initialize();
			// expect(mockServerConnection.getChannel).toHaveBeenCalledTimes(2);
			// expect(channelListenerSubscribe).toHaveBeenCalledTimes(1);
			// expect(subscribeToCometD).toHaveBeenCalledTimes(1);
		});
		
		it('initializes again if new redirect channel', () => {
			let clientID = "firstClientId";
			let firstClientChannelName = "/sn/meta/channel_redirect/firstClientId";
			let secondClientChannelName = "/sn/meta/channel_redirect/secondClientId";

			const firstChannel = getMockChannel(firstClientChannelName);
			const secondChannel =  getMockChannel(secondClientChannelName); 

			let mockCometDWithDifferentClientIDs = mock(CometD);
			mockCometDWithDifferentClientIDs.getClientId.mockImplementation(() => {
				return clientID;
			})
			mockServerConnection = getMockServerConnection();
			mockServerConnection.getChannel.mockImplementation((channelName) => {
				return channelName === firstClientChannelName ? firstChannel : secondChannel;
			});

			const testChannelRedirect = new ChannelRedirect(mockCometDWithDifferentClientIDs, mockServerConnection);
			testChannelRedirect.initialize(() => {});
			expect(firstChannel.subscribe).toHaveBeenCalledTimes(1);
			expect(mockServerConnection.getChannel).toHaveBeenCalledWith(firstClientChannelName);

			clientID = "secondClientId";
			testChannelRedirect.initialize(() => {});
			expect(secondChannel.subscribe).toHaveBeenCalledTimes(1);
			expect(mockServerConnection.getChannel).toHaveBeenCalledWith(secondClientChannelName);
		})
	});


	// Callback for channel redirect message
	describe('_onAdvice', () => {
		it('triggers channel redirect event', () => {
			let channelResult:any = null;
			mockServerConnection = getMockServerConnection();
			let mockListener = getMockChannelListener();
			mockListener.setNewChannel.mockImplementation((channel) => {
				channelResult = channel;
			});
			const toChannel = getMockChannel("toChannel");//new Channel(mockServerConnection, null, 'toChannel', false);
			const fromChannel =  getMockChannel("fromChannel"); //new Channel(mockServerConnection, null, 'fromChannel', false);

			fromChannel.getChannelListeners.mockReturnValue([mockListener, mockListener]);

			mockServerConnection.getChannel.mockImplementation((channelName) => {
				return channelName === 'toChannel' ? toChannel : fromChannel;
			});

			const advice = {
				data : {
					fromChannel : 'fromChannel',
					toChannel : 'toChannel'
				}
			};

			testChannelRedirect = new ChannelRedirect(mockCometD, mockServerConnection);
			testChannelRedirect._onAdvice(advice);

			expect(mockServerConnection.getChannel).toHaveBeenCalledTimes(2);
			expect(mockServerConnection.getChannel).toHaveBeenLastCalledWith('toChannel');

			expect(fromChannel.getChannelListeners).toHaveBeenCalledTimes(1);
			expect(mockListener.setNewChannel).toHaveBeenCalledTimes(2);
			expect(mockListener.setNewChannel).toHaveBeenLastCalledWith(toChannel);
			expect(channelResult).toBe(toChannel);
		});
	});
});
