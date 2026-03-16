/* eslint-disable @typescript-eslint/ban-types */

import { Channel } from "./Channel";
import { Logger } from "../../util/Logger";
import { ServerConnection } from "./ServerConnection";

export class ChannelListener{

	 id = -1;
	 messageCallback:Function | null;
	 _logger = new Logger("ChannelListener");
	 _channel:Channel;
	 _subscriptionCallback:Function | null;
	 _serverConnection:ServerConnection;

	constructor(channel:Channel, serverConnection:ServerConnection, subscriptionCallback:Function | null) {
		this._channel = channel;
		this._subscriptionCallback = subscriptionCallback;
		this._serverConnection = serverConnection;
		this.messageCallback = null;
	}


	getCallback() {
		return this.messageCallback;
	}

	getSubscriptionCallback() {
		return this._subscriptionCallback;
	}

	getID() : number {
		return this.id;
	}

	setNewChannel(channel:Channel) {
		this._channel.unsubscribe(this);
		this._channel = channel;
		this.subscribe(this.messageCallback);
	}

	/**
	 * Register this listener with its channel.
	 *
	 * @return amb.ChannelListener this listener
	 */
	subscribe(/*Function*/ callback:Function) {
		this.messageCallback = callback;
		this.id = this._channel.subscribe(this);
		return this;
	}

	resubscribe() {
		return this.subscribe(this.messageCallback);
	}

	/**
	 * Unregister this listener from its channel.
	 *
	 * @return amb.ChannelListener this listener
	 */
	unsubscribe(listener?:Function) {
		this._channel.unsubscribe(this);
		this._logger.debug("Unsubscribed from channel: " + this._channel.getName());
		return this;
	}

	publish(/*Hash*/ message:any) {
		this._channel.publish(message);
	}

	getName() {
		return this._channel.getName();
	}
}

