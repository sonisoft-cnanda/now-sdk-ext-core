import {Logger} from "../../util/Logger";

export class  SessionExtension {
	static META_CONNECT = "/meta/connect";
	
	 _logger:Logger = new Logger("SessionExtension");
	_extendSession = false;

	public extendSession() : void {
		this._extendSession = true;
	}

	public outgoing(message:any) : void {
		if (message.channel === SessionExtension.META_CONNECT && this._extendSession) {
			if (!message.ext)
				message.ext = {};

			this._logger.debug("extendSession");
			message.ext.extendSession = true;
			this._extendSession = false;
		}

		return message;
	}
}