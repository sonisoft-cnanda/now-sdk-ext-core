/* eslint-disable @typescript-eslint/ban-types */
import {Logger}  from "../../util/Logger";
import { isEmptyObject, isNil } from "../../util/utils";
import { ChannelListener } from "./ChannelListener";
import {SubscriptionCommandSender} from "./SubscriptionCommandSender";
import { ServerConnection } from "./ServerConnection";

export class Channel{

	 subscription:any = null;
	 subscriptionCallbackResponse:any  = null;
	 listeners:ChannelListener[]  = [];
	 listenerCallbackQueue:any[]  = [];
	 _logger:Logger = new Logger("Channel");
	 idCounter = 0;
	 _initialized:boolean;
	 _channelName:string;
	_cometd:any;
	_subscribeOptionsCallback:any;
	_serverConnection:ServerConnection;

	public constructor(conn:ServerConnection, cometd:any, channelName:string, initialized:boolean, subscribeOptionsCallback = (() => { return {}; })){
		
		this._serverConnection = conn;
		this._initialized = initialized;
		this._channelName = channelName;
		this._cometd = cometd;
		this._subscribeOptionsCallback = subscribeOptionsCallback;
	}

	private _disconnected() {
		const status = this._cometd.getStatus();
		return status === "disconnecting" || status === "disconnected";
	}
	
	private getSubscriptionCommandSender():SubscriptionCommandSender | null {
		return this.getServerConnection().getSubscriptionCommandSender();
	}


	public getServerConnection(): ServerConnection{
		return this._serverConnection;
	}

	/**
	 * Subscribe to have this channel's messages be published to the specified
	 * callback.
	 *
	 * @return Integer id for the newly registered listener
	 */
	public subscribe(listener:ChannelListener) : number | null {

		if (!listener.getCallback()) {
			this._logger.addErrorMessage("Cannot subscribe to channel: " + this._channelName
				+ ", callback not provided");
			return null;
		}

		for (let i = 0; i < this.listeners.length; i++) {
			if ( this.listeners[i] === listener) {
				this._logger.debug("Channel listener already in the list");
				return listener.getID();
			}
		}

		this.listeners.push(listener);

		const listenerSubCallback = listener.getSubscriptionCallback();
		if (listenerSubCallback) {
			if (this.subscriptionCallbackResponse) {
				listenerSubCallback(this.subscriptionCallbackResponse);
			}
			else {
				this.listenerCallbackQueue.push(listenerSubCallback);
			}
		}

		if (!this.subscription && this._initialized) {
			try {
				this.subscribeToCometD();
			} catch (e) {
				this._logger.addErrorMessage("Error subscribing to cometd.",e);
				return null;
			}
		}

		return ++this.idCounter;
	}

	public resubscribe() {
		this.subscription = null;
		for (let i = 0; i < this.listeners.length; i++)
			this.listeners[i].resubscribe();
	}


	_handleResponse(message:any) {
		this._logger.debug("_handleResponse: callback executed. Executing listener callbacks.", message);
		for (let i = 0; i <this.listeners.length; i++){
			const listener:ChannelListener = this.listeners[i];
			if(listener != null){
				this._logger.debug("Retrieved Channel Listener. Executing callback", listener);
				const callback:Function | null= listener.getCallback();
				if(callback != null){
					this._logger.debug("_handleResponse: listener callback not null, executing.", listener);
					callback(message);
				}else
					this._logger.addWarnMessage("_handleResponse: Listener callback null.");	
			}else{
				this._logger.debug("_handleResponse: listener null...");
			}
			
		}
			
	}

	/**
	 * Remove listener from channel, so callback pertaining to listener
	 * no longer receives messages published to channel. When the last
	 * listener is removed, the subscription is destroyed.
	 */
	unsubscribe(/*amb.ChannelListener*/ listener:ChannelListener) {
		if (!listener) {
			this._logger.addErrorMessage("Cannot unsubscribe from channel: " + this._channelName
				+ ", listener argument does not exist");
			return;
		}

		// Remove listener
		for (let i = 0; i < this.listeners.length; i++) {
			if (this.listeners[i].getID() === listener.getID()) {
				this.listeners.splice(i, 1);
				break;
			}
		}

		// Unsubscribe if we've removed the last listener
		if (this.listeners.length < 1 && this.subscription && !this._disconnected())
			this.unsubscribeFromCometD();
	}

	publish(/*Hash*/ message:any) {
		this._cometd.publish(this._channelName, message);
	}

	subscribeToCometD() {
		this._logger.debug("subscribeToCometD channelName : " + this._channelName + ", subscription : " + this.subscription);
		const commandSender:SubscriptionCommandSender | null = this.getSubscriptionCommandSender();

		if (commandSender != null)
			commandSender.subscribeToChannel(this);
		else
			this._subscribeToCometD(this.subscriptionCallback);
	}
	
	_subscribeToCometD(overLoadedSubscriptionCallBack:any) {
		this._logger.debug("_subscribeToCometD channelName : " + this._channelName);
		const subscribeOptions = this._subscribeOptionsCallback();
		if (isNil(subscribeOptions) || isEmptyObject(subscribeOptions))
			this.subscription = this._cometd.subscribe(this._channelName,null, this._handleResponse.bind(this), null, overLoadedSubscriptionCallBack);
		else {
			const subscribeOptionsWrapper = {"subscribeOptions": subscribeOptions};
			this.subscription = this._cometd.subscribe(this._channelName,null, this._handleResponse.bind(this), subscribeOptionsWrapper,overLoadedSubscriptionCallBack);
		}
		this._logger.debug("Successfully subscribed to channel: " + this._channelName + ", Subscribe options: " + subscribeOptions);
	}

	/**
	 * Callback that gets fired when a cometd channel subscription is completed.
	 * Triggers channel listener callbacks.
	 * @param response
	 */
	subscriptionCallback  (response:any) {
		this._logger.debug("Cometd subscription callback completed for channel: " + this._channelName);
		this._logger.debug("Listener callback queue size: " + this.listenerCallbackQueue.length);
		this.subscriptionCallbackResponse = response;

		this.listenerCallbackQueue.map((listenerSubCallback) => {
			listenerSubCallback(this.subscriptionCallbackResponse);
		});

		this.listenerCallbackQueue = [];
	}

	unsubscribeFromCometD() {
		this._logger.debug("unsubscribeFromCometD  from : " + this._channelName + ", subscription : " + this.subscription);
		if (this.subscription !== null) {
			const commandSender:SubscriptionCommandSender | null = this.getSubscriptionCommandSender();

			if (commandSender != null)
				commandSender.unsubscribeToChannel(this);
			else
				this._unsubscribeFromCometD();	
		}
	}

	_unsubscribeFromCometD() {
		this._logger.debug("_unsubscribeFromCometD  from : " + this._channelName + ", subscription : " + this.subscription);
		if (this.subscription !== null) {
			this._cometd.unsubscribe(this.subscription);
			this.subscription = null;
			this.subscriptionCallbackResponse = null;
			this._logger.debug("Successfully unsubscribed from channel: " + this._channelName);
		}
	}

	resubscribeToCometD() {
		this._logger.debug("Resubscribe to " + this._channelName);
		const commandSender:SubscriptionCommandSender | null = this.getSubscriptionCommandSender();

		if (commandSender != null)
			commandSender.subscribeToChannel(this);
		else
			this._subscribeToCometD(this.subscriptionCallback);
	}

	getSubscribeOptionsCallback() {
		return this._subscribeOptionsCallback;
	}

	getName() {
		return this._channelName;
	}

	/**
	 * Returns the array of amb.ChannelListeners.
	 * @returns {Array}
	 */
	getChannelListeners() {
		return this.listeners;
	}

	/**
	 * Returns the array of channel listener subscription callbacks
	 * For unit testing.
	 * @returns {Array}
	 */
	getListenerCallbackQueue() {
		return this.listenerCallbackQueue;
	}

	/**
	 * Don't use this, for unit testing.
	 * Need the ability to set the subscription callback response from cometd subscribe callback
	 *
	 * @param response
	 */
	setSubscriptionCallbackResponse (response:any) {
		this.subscriptionCallbackResponse = response;
	}


}
