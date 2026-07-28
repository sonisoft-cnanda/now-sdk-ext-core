/* eslint-disable @typescript-eslint/ban-types */
//import * as cometd from 'cometd';
//const {CometD, WebSocketTransport, LongPollingTransport } = cometd;

import { CometD } from "cometd";
import {LongPollingTransport} from "cometd/LongPollingTransport";
import {WebSocketTransport} from "cometd/WebSocketTransport";
import {ServerConnection} from "./ServerConnection";
import {ChannelListener} from "./ChannelListener";
import {GraphQLSubscriptionExtension} from "./GraphQLSubscriptionExtension";

import {SessionExtension} from "./SessionExtension";
import {TokenManagementExtension} from "./TokenManagementExtension";
import { AMBConstants } from "./AMBConstants";
import { Logger } from "../../util/Logger";

export type SubscriptionConfig = {
	subscriptionCallback?:Function;
	serializedGraphQLSubscription?:any;
	subscribeOptionsCallback?:Function;
}

export class MessageClient {
	//adapt();
	
	//CometD Object
	_cometd:any;

	// Register extension needed for GraphQL subscriptions.
	graphQLSubscriptionExtension:GraphQLSubscriptionExtension = new GraphQLSubscriptionExtension();
	sessionExtension:SessionExtension = new SessionExtension();
	tokenManagementExtension:TokenManagementExtension = new TokenManagementExtension();

	serverConnection:ServerConnection;
	_logger = new Logger("amb.MessageClient");

	public connected = false;


	public constructor(){
		this._cometd = new CometD();

		this._cometd.registerTransport(AMBConstants.WEBSOCKET_TYPE_NAME, new WebSocketTransport(), 0);
		this._cometd.registerTransport("long-polling", new LongPollingTransport(), 1);
		this._cometd.unregisterTransport("callback-polling");
		//this._cometd.unregisterTransport(AMBConstants.WEBSOCKET_TYPE_NAME);
		this._cometd.registerExtension("graphQLSubscription", this.graphQLSubscriptionExtension);
		this._cometd.registerExtension("sessionExtension", this.sessionExtension);
		this._cometd.registerExtension(AMBConstants.TOKEN_MANAGEMENT_EXTENSION, this.tokenManagementExtension);

		this.serverConnection = new ServerConnection(this._cometd);
	}

	//public

		getServerConnection() : ServerConnection {
			return this.serverConnection;
		}

		isLoggedIn() {
			return this.serverConnection.isLoggedIn();
		}

		loginComplete() {
			this.serverConnection.loginComplete();
		}

		reestablishSession() {
			this.serverConnection.reestablishSession();
		}

		/**
		 * Server Connection
		 */

		connect() {
			if (this.connected) {
				this._logger.addInfoMessage(">>> connection exists, request satisfied");
				return;
			}
			this.connected = true;
			this.serverConnection.connect();
		}

		reload() {
			this.connected = false;
			this.serverConnection.reload();
		}

		abort() {
			this.connected = false;
			this.serverConnection.abort();
		}

		disconnect() {
			this.connected = false;
			this.serverConnection.disconnect();
		}

		// For unit testing.
		isConnected() {
			return this.connected;
		}

		/**
		 * Connection Events
		 */

		getConnectionEvents() {
			return this.serverConnection.getEvents();
		}

		subscribeToEvent(/*String*/ event:string, /*Function*/ callback:Function): number {
			return this.serverConnection.subscribeToEvent(event, callback);
		}
		
		unsubscribeFromEvent(/*Number*/ id:number) {
			this.serverConnection.unsubscribeFromEvent(id);
		}

		getConnectionState() : string {
			return this.serverConnection.getConnectionState();
		}

		/**
		 * Client info
		 */
		getClientId() : string {
			return this._cometd.getClientId();
		}

		/**
		 * Channels
		 */
		getChannel(channelName:string, subscriptionConfig:SubscriptionConfig) : ChannelListener {
			const {
				subscriptionCallback,
				serializedGraphQLSubscription,
				subscribeOptionsCallback
			} = subscriptionConfig || {};

			const subCallback:Function | null = subscriptionCallback ? subscriptionCallback : null;

			const channel = this.serverConnection.getChannel(channelName, subscribeOptionsCallback);

			if (this.graphQLSubscriptionExtension.isGraphQLChannel(channelName)) {
				if (serializedGraphQLSubscription)
					this.graphQLSubscriptionExtension.addGraphQLChannel(channelName, serializedGraphQLSubscription);
				else
					this._logger.addErrorMessage("Serialized subscription not present for GraphQL channel " + channelName);
			}

			return new ChannelListener(channel, this.serverConnection, subCallback);
		}

		removeChannel(channelName:string) {
			this.serverConnection.removeChannel(channelName);

			if (this.graphQLSubscriptionExtension.isGraphQLChannel(channelName))
				this.graphQLSubscriptionExtension.removeGraphQLChannel(channelName);
		}

		getChannels() {
			return this.serverConnection.getChannels();
		}

		extendSession() {
			this.sessionExtension.extendSession();
		}

		getTokenManagementExtension() {
			return this.tokenManagementExtension;
		}

		/**
		 * Extensions
		 */

		registerExtension(extensionName:string,extension:any) {
			this._cometd.registerExtension(extensionName, extension);
		}

		unregisterExtension(extensionName:string) {
			this._cometd.unregisterExtension(extensionName);
		}


		/**
		 * Utility
		 */

		/**
		 * Executes messages in a batch.
		 *
		 * block is an anonymous function, containing a chain of messages to be posted
		 * together, and executed in sequence
		 *
		 * Example:
		 *        block = function() {
         * 			channel.subscribe();
         *			channel.publish({ user: 'Fred', message: 'Fred has joined the channel' });
         *		}
		 */
		batch( block:Function) {
			this._cometd.batch(block);
		}


	
}

