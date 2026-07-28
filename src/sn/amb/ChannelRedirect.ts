/* eslint-disable @typescript-eslint/ban-types */
import {Logger} from "../../util/Logger";
import {ChannelListener} from "./ChannelListener";
import { ServerConnection } from "./ServerConnection";
import { Channel } from "./Channel";

export class ChannelRedirect{

	_metaChannel:Channel | null;
	_cometd:any;
	_serverConnection:ServerConnection;
	_logger:Logger = new Logger("ChannelRedirect");


	constructor(cometd:any, serverConnection:ServerConnection) {
		this._cometd = cometd;
		this._serverConnection = serverConnection;
		this._metaChannel = null;
	}


	private  _switchToChannel(fromChannel:Channel, toChannel:Channel) {

		const listeners = fromChannel.getChannelListeners();
		for (let i = 0; i < listeners.length; i++) {
			const listener = listeners[i];
			listener.setNewChannel(toChannel);
		}

	}

	 public _onAdvice(advice:any) {
		this._logger.debug("_onAdvice:" + advice.data.clientId);
		const fromChannel:Channel = this._serverConnection.getChannel(advice.data.fromChannel);
		const toChannel:Channel= this._serverConnection.getChannel(advice.data.toChannel);

		if (!fromChannel || !toChannel) {
			this._logger.debug("Could not redirect from " + advice.data.fromChannel + " to " + advice.data.toChannel);
			return;

		}
		this._switchToChannel(fromChannel, toChannel);

		this._logger.debug(
			"published channel switch event, fromChannel:" + fromChannel.getName()
			+ ", toChannel:" + toChannel.getName());
	}



		public initialize(onSubscriptionCompleted:Function) {
			const channelName = "/sn/meta/channel_redirect/" + this._cometd.getClientId();
			const newMetaChannel = this._serverConnection.getChannel(channelName);

			// Only do this when we're creating a new redirect channel
			if (!this._metaChannel || newMetaChannel !== this._metaChannel) {

				// Delete old redirect channel in case of reconnection
				if (this._metaChannel)
					this._serverConnection.removeChannel(this._metaChannel.getName());

				this._metaChannel = newMetaChannel;
				//channelRedirect meta channelListener will not get redirected
				new ChannelListener(this._metaChannel, this._serverConnection, onSubscriptionCompleted).subscribe(this._onAdvice);

			} else
				this._metaChannel.subscribeToCometD();

				this._logger.debug("ChannelRedirect initialized: " + channelName);
		}

		


	

}

