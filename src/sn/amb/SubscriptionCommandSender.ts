import {Properties as properties} from "./Properties";
import { isNil, isObject } from "../../util/utils";
import {Logger} from "../../util/Logger";
import { FunctionQueue } from "./FunctionQueue";

/**
 * Controls the flow of subscription-related (subscribe, resubscribe, unsubscribe) commands
 * @param commandQueue  the queue to hold commands to process.
 */
export class SubscriptionCommandSender {
	static CommandModes:any = {SUBSCRIBE: "subscribe", UNSUBSCRIBE: "unsubscribe"};
	static HTTP_STATUS_ACCEPTED = 202;
	static HTTP_STATUS_TOO_MANY_REQUESTS = 429;
	maxTimeInterval:number = 5 * 60 * 1000;    /* 5 minutes in milliseconds */
	_logger:Logger = new Logger("SubscriptionCommandSender");
	stopping = !properties.instance.subscribeCommandsFlow.enable;
	timerObject:any = null;
	tokenManager:any;
	commandQueue:FunctionQueue;


	public constructor(commandQueue:FunctionQueue, tokenManager:any){
		this.commandQueue = commandQueue;
		this.tokenManager = tokenManager;
		this.registerToTokenAvailabilityListener();
	}

	private  _clamp(val:any, minLimit:any, maxLimit:any) {
		return Math.min(maxLimit, Math.max(minLimit, val));
	}

	private  getTokenCount() {
		return this._clamp(this.tokenManager.getTokenCount(), 0, properties.instance.subscribeCommandsFlow.maxInflight);
	}

	private isBucketFull() {
		return this.tokenManager.getTokenCount() >= properties.instance.subscribeCommandsFlow.maxInflight;
	}

	private registerToTokenAvailabilityListener() {
		
		this.tokenManager.addTokenAvailabilityListener((): void =>  {
			this.processQueue();
		});
	}

	private restartTimer(force = true) {
		if (force || isNil(this.timerObject)) {
			const timeInterval = this._clamp(properties.instance.subscribeCommandsFlow.maxWait, 0, this.maxTimeInterval);
			this._logger.debug("restartTimer - force: " + force + ", timerObject : " + this.timerObject + ", timeInterval : " + timeInterval);
			this.stopTimer();
			this.timerObject = setTimeout(() => {
				this.onTimer();
			}, timeInterval);
		}

	}

	private  stopTimer() {
		if (!isNil(this.timerObject)) {
			this._logger.debug("stopTimer");
			clearTimeout(this.timerObject);
			this.timerObject = null;
		}
	}

	private signalStop() {
		this._logger.debug("signalStop - stopping : " + this.stopping);
		if (!this.stopping) {
			this.stopping = true;
			this.stopTimer();
			this.commandQueue.clear();
		}
	}

	private getRetryDelay() {
		let delay = parseInt(properties.instance.subscribeCommandsFlow.retryDelay.min);
		delay = this._clamp(delay, 0, this.maxTimeInterval);
		return delay;
	}

	private  scheduleRetry(channel:any, triesLeft:any, mode:any, retryDelay:any) {
		this._logger.debug("scheduleRetry - channel : " + channel.getName() + ", triesLeft : " + triesLeft + ", mode : " + mode);
		let retryMessage:any;
		const newRetryDelay = this.getNewRetryDelay(retryDelay);
		switch (mode) {
			case SubscriptionCommandSender.CommandModes.SUBSCRIBE: {
				retryMessage = (() => this.enqueueSubscribe(channel, triesLeft, newRetryDelay));
				break;
			}
			case SubscriptionCommandSender.CommandModes.UNSUBSCRIBE: {
				retryMessage = (() => this.enqueueUnsubscribe(channel, triesLeft, newRetryDelay));
				break;
			}
		}
		if (!isNil(retryMessage))
			setTimeout(retryMessage, retryDelay);
	}

	private  onResponse(response:any, channel:any, mode:any, triesLeft:any, retryDelay:any) {
		// `response` and `channel` go in the metadata rather than the message, because
		// only metadata passes through the redaction format. That is a real guarantee
		// ONLY for keys the format recognises — a Bayeux response carries `clientId`,
		// which authorises every later message on this connection, so it had to be
		// added to SECRET_KEYS for this to be safe. Adding a field here that carries a
		// secret under an unrecognised name puts it on disk.
		/* eslint-disable @typescript-eslint/no-unsafe-assignment -- the whole CometD
		   surface is `any`; these were already interpolated into the message before. */
		this._logger.debug("onResponse", {
			response: response,
			channel: channel,
			mode: mode,
			triesLeft: triesLeft,
			stopping: this.stopping,
			tokenCount: this.tokenManager.getTokenCount(),
			isBucketFull: this.isBucketFull(),
			retryDelay: retryDelay,
		});
		/* eslint-enable @typescript-eslint/no-unsafe-assignment */

		if (!this.stopping) {
			triesLeft = triesLeft - 1;
			if (this.isBucketFull())
				this.stopTimer();
			if ((triesLeft > 0) && this.isRetriable(response))
				this.scheduleRetry(channel, triesLeft, mode, retryDelay);
			else
				channel.subscriptionCallback(response);

			this.processQueue();
		} else
			channel.subscriptionCallback(response);
	}
	
	private  getNewRetryDelay(retryDelay:any) {
		return this._clamp(properties.instance.subscribeCommandsFlow.retryDelay.increaseFactor * retryDelay,
			properties.instance.subscribeCommandsFlow.retryDelay.min,
			properties.instance.subscribeCommandsFlow.retryDelay.max);
	}

	private  onTimer() {
		this.timerObject = null;
		this._logger.debug("onTimer - stopping : " + this.stopping);
		if (!this.stopping) {
			this.tokenManager.refillTokens();
			this.processQueue();
		}
	}

	private  addItemToQueue(item:any) {
		this._logger.debug("addItemToQueue - item : " + item);
		if (this.commandQueue.enqueue(item)) {
			this.processQueue();
			return true;
		}
		return false;
	}

	private  enqueueSubscribe(channel:any, triesLeft:any = null, retryDelay = this.getRetryDelay()) {
		this._logger.debug("enqueueSubscribe - channel: " + channel.getName() + ", triesLeft : " + triesLeft + ", stopping : " + this.stopping + ", retryDelay : " + retryDelay);
		if (!this.stopping) {
			if (isObject(channel)) {
				if (isNil(triesLeft))
					triesLeft = 1 + Math.floor(properties.instance.subscribeCommandsFlow.retries);

				if (triesLeft > 0) {
					const item = (() => {
						this._logger.debug("enqueueSubscribe - inside the item execution. Calling channel._subscribeToCometD - channel: " +
							channel.getName() + ", triesLeft : " + triesLeft);
						channel._subscribeToCometD((resp:any) =>
							this.onResponse(resp, channel, SubscriptionCommandSender.CommandModes.SUBSCRIBE, triesLeft, retryDelay));
					});
					return this.addItemToQueue(item);
				}
			}
		}
		return false;
	}

	private  enqueueUnsubscribe(channel:any, triesLeft:any = null, retryDelay = this.getRetryDelay()) {
		this._logger.debug("enqueueUnsubscribe - channel: " + channel.getName() + ", triesLeft : " + triesLeft + ", stopping : " + this.stopping + ", retryDelay : " + retryDelay);
		if (!this.stopping) {
			if (isObject(channel)) {
				if (isNil(triesLeft))
					triesLeft = 1 + Math.floor(properties.instance.subscribeCommandsFlow.retries);
				if (triesLeft > 0) {
					const item = (() => {
						channel._unsubscribeFromCometD((resp:any) => this.onResponse(resp, channel, SubscriptionCommandSender.CommandModes.UNSUBSCRIBE, triesLeft, retryDelay));
					});
					return this.addItemToQueue(item);
				}
			}
		}
		return false;
	}

	private  isRetriable(response:any) {
		this._logger.debug("isRetriable - response : " + response);
		if (response && response.ext) {
			const isRejected = response.ext["rejected_by_glide"];
			if (isRejected) {
				const statusCode = parseInt(response.ext["glide.amb.reply.status.code"]);
				this._logger.addWarnMessage("isRetriable - rejected_by_glide : " + isRejected + ", glide.amb.reply.status.code : " + statusCode);
				if (!isNaN(statusCode))
					return ((statusCode == SubscriptionCommandSender.HTTP_STATUS_TOO_MANY_REQUESTS) ||
						(statusCode == SubscriptionCommandSender.HTTP_STATUS_ACCEPTED));
			}
		}
		this._logger.debug("isRetriable -  " + false);
		return false;
	}

	private  processQueue() {
		const numberToProcess = Math.min(this.commandQueue.getSize(), this.getTokenCount());
		this._logger.debug("processQueue - numberToProcess : " + numberToProcess);
		if (numberToProcess > 0) {
			const itemsToRun = this.commandQueue.dequeueMultiple(numberToProcess);
			itemsToRun.forEach((item:any) => isNil(item) || item());
			this.restartTimer(false);    // false: don't push the timer farther away if already running.
		}
	}

	
		/**
		 * Adds a request to subscribe to the specified channel.
		 * @param channel  the channel to subscribe
		 * @returns  true if accepted; false if there's insufficient room
		 */
		public subscribeToChannel(channel:any) {
			this._logger.debug("subscribeToChannel - to : " + channel.getName());
			return this.enqueueSubscribe(channel);
		}

		/**
		 * Adds a request to unsubscribe to the specified channel.
		 * @param channel  the channel to unsubscribe
		 * @returns  true if accepted; false if there's insufficient room
		 */
		public unsubscribeToChannel(channel:any) {
			this._logger.debug("unsubscribeToChannel - from : " + channel.getName());
			return this.enqueueUnsubscribe(channel);
		}
		/**
		 * Signals this instance to stop.
		 */
		public stop() {
			this._logger.debug("stop");
			this.signalStop();
		}
		/**
		 * Whether this instance is stopped or stopping.
		 * @returns  true if stopped or stopping; otherwise false.
		 */
		public isStopping() {
			return this.stopping;
		}

		public getQueue() {
			return this.commandQueue;
		}

		public isBucketEmpty() {
			return !this.isBucketFull();
		}

		public getTimerObject() {
			return this.timerObject;
		}
		
		public getTokenCountFromTokenManager() {
			return this.tokenManager.getTokenCount();
		}
	
}