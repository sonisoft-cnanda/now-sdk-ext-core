import {Logger} from "../../util/Logger";
import {Properties as properties} from "./Properties";



export class TokenManagementExtension {
	 _logger:Logger = new Logger("amb.TokenManagementExtension");
	 static META_SUBSCRIBE = "/meta/subscribe";
	 static META_UNSUBSCRIBE = "/meta/unsubscribe";
	static  META_HANDSHAKE = "/meta/handshake";
	 tokenCount:any = properties.instance.subscribeCommandsFlow.maxInflight;
	 tokenEventListeners:any[] = [];

	updateTokenCount(count:any) {
		this.tokenCount = count;
	}
	
	refillTokens() {
		this.tokenCount = properties.instance.subscribeCommandsFlow.maxInflight;
		this.notifyOnAvailabilityOfToken();
		this._logger.debug("refillTokens -- tokenCount : " + this.tokenCount);
	}

	 isMetaSubUnsubChannel(message:any) {
		return message.channel == TokenManagementExtension.META_SUBSCRIBE || message.channel == TokenManagementExtension.META_UNSUBSCRIBE;
	}

	 isReceivedByGlideAndMetaSubUnsubChannel(message:any) {
		if (!message.ext)
			return false;

		const receivedByGlide = message.ext["received_by_glide"];
		if (!receivedByGlide)
			return false;

		return receivedByGlide && this.isMetaSubUnsubChannel(receivedByGlide);
	}

	 isMetaHandshake(message:any) {
		return message.channel === TokenManagementExtension.META_HANDSHAKE;
	}

	public outgoing(message:any) {
		if (this.isMetaHandshake(message)) {
			if (!message.ext)
				message.ext = {};

			message.ext.supportsSubscribeCommandFlow = true;
		}
		
		if (!properties.instance.subscribeCommandsFlow.enable)
			return message;

		if (this.isMetaSubUnsubChannel(message) && this.tokenCount > 0)
			this.tokenCount--;

		return message;
	}

	public incoming(message:any) {
		if (!properties.instance.subscribeCommandsFlow.enable)
			return message;

		if (this.isMetaSubUnsubChannel(message)) {
			if (this.tokenCount < properties.instance.subscribeCommandsFlow.maxInflight)
				this.tokenCount++;

			this.notifyOnAvailabilityOfToken();
		} else if (this.isReceivedByGlideAndMetaSubUnsubChannel(message)) {
			message = null; // Make cometd not to call back any listeners based on the message id.
		}

		return message;
	}

	public getTokenCount() {
		return this.tokenCount;
	}

	public addTokenAvailabilityListener(tokenEventListener:any) {
		if (!tokenEventListener)
			return;

		this._logger.debug("addTokenAvailabilityListener - tokenEventListener : " + tokenEventListener);
		this.tokenEventListeners.push(tokenEventListener);
	}

	public removeTokenAvailabilityListener(tokenEventListener:any) {
		if (!tokenEventListener)
			return;

		this._logger.debug("removeTokenAvailabilityListener - tokenEventListener : " + tokenEventListener);
		const removeIndex = this.tokenEventListeners.findIndex(listener => {
			return tokenEventListener === listener;
		});

		if (removeIndex !== -1) {
			this._logger.debug("removeTokenAvailabilityListener - removing listener at index : " + removeIndex);
			this.tokenEventListeners.splice(removeIndex, 1);
		}
	}

	public notifyOnAvailabilityOfToken() {
		this._logger.debug("notifyOnAvailabilityOfToken - current tokenCount: " + this.tokenCount);
		try {
			this.tokenEventListeners.forEach((listener:any) => {
				listener();
			});
		} catch (error) {
			this._logger.addErrorMessage("notifyOnAvailabilityOfToken - failed to call tokenEventListeners. Error Details : " + error);
		}
	}
}