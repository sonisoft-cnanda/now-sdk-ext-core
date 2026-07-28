/* eslint-disable @typescript-eslint/ban-types */
import {EventManager} from "./EventManager";
import {Logger} from "../../util/Logger";

import { isNil, isObject } from "./Helper";
import { AMBConstants } from "./AMBConstants";
import { XMLHttpRequest } from "./XMLHttpRequest";
import {Properties as properties} from "./Properties";
import {ChannelRedirect} from "./ChannelRedirect";
import {Channel} from "./Channel";
import {CrossClientChannel} from "./CrossClientChannel";
import {FunctionQueue} from "./FunctionQueue";
import {SubscriptionCommandSender} from "./SubscriptionCommandSender";

export class ServerConnection {

	connected = false;
	disconnecting = false;
	eventManager:EventManager = new EventManager({
		CONNECTION_INITIALIZED: "connection.initialized",
		CONNECTION_OPENED: "connection.opened",
		CONNECTION_CLOSED: "connection.closed",
		CONNECTION_BROKEN: "connection.broken",
		SESSION_LOGGED_IN: "session.logged.in",
		SESSION_LOGGED_OUT: "session.logged.out",
		SESSION_INVALIDATED: "session.invalidated",
		SESSION_REESTABLISHED: "session.reestablished"
	});
	static sessionStates:any = {
		SESSION_LOGGED_IN: "session.logged.in",
		SESSION_LOGGED_OUT: "session.logged.out",
		SESSION_INVALIDATED: "session.invalidated"
	};
	state = "closed";
	channels:any = {};
	 _logger:Logger = new Logger("ServerConnection");

	sessionStatus:string;
	loginWindow:any = null;
	loginWindowEnabled = false;
	lastError:any = null;
	errorMessages:any = {"UNKNOWN_CLIENT": "402::Unknown client"};
	loginWindowOverride = false;
	//ambServerConnection:ServerConnection = {};
	needToReestablishSession = false;
	channelRedirect:ChannelRedirect;
	initialized = false;
	
	tokenManagementExtension:any; 
	_cometd:any;
	_crossClientChannel:CrossClientChannel;
	subscriptionCommandSender:SubscriptionCommandSender | null = null;
	
	// Dynamic configuration
	private _instanceUrl: string | null = null;
	private _sessionCookies: string | null = null;
	private _userToken: string | null = null;



	constructor(cometd:any, crossClientChannel = new CrossClientChannel()) {
		this._cometd = cometd;
		this._crossClientChannel = crossClientChannel;

		this._initializeMetaChannelListeners();
		this.sessionStatus = ServerConnection.sessionStates.SESSION_INVALIDATED;
		this.channelRedirect = new ChannelRedirect(cometd, this);

		this.tokenManagementExtension = cometd.getExtension(AMBConstants.TOKEN_MANAGEMENT_EXTENSION);
	}

	/**
	 * Set the ServiceNow instance URL dynamically
	 * @param url Instance URL (e.g., <servicenow_instance_url>)
	 */
	public setInstanceUrl(url: string) {
		this._instanceUrl = url;
	}

	/**
	 * Set session cookies for authentication
	 * @param cookies Cookie string (e.g., "JSESSIONID=xxx; glide_session_store=yyy")
	 */
	public setSessionCookies(cookies: string) {
		this._sessionCookies = cookies;
	}

	/**
	 * Set user token for AMB authentication
	 * @param token User token string
	 */
	public setUserToken(token: string) {
		this._userToken = token;
	}

	private _initializeMetaChannelListeners() {
		this._cometd.addListener("/meta/handshake", this, this._metaHandshake);
		this._cometd.addListener("/meta/connect", this, this._metaConnect);
		this._cometd.addListener("/meta/subscribe", this, this.applyAMBProperties);
		this._cometd.addListener("/meta/unsubscribe", this, this.applyAMBProperties);
	}

	public connect() {
		//let conn:ServerConnection = this;
		// Protection against anyone who things they should be calling connect
		if (this.connected) {
			this._logger.debug(">>> connection exists, request satisfied");
			return;
		}

		if (!this._sessionCookies) {
			throw new Error("Session cookies not configured. Call AMBClient.authenticate() before connect().");
		}
		const cookieHeader = this._sessionCookies;

		this._logger.debug("Connecting to glide amb server", properties);
		const configParameters:any = {
			url: this.getURL(properties.instance["servletPath"]),
			logLevel: properties.instance.logLevel,
			connectTimeout: properties.instance["wsConnectTimeout"],
			requestHeaders: {
				"cookie": cookieHeader
			}
		};
		this._logger.debug("Configuration Parameters", configParameters);
		this._cometd.configure(configParameters);
		this._cometd.handshake((h:any) => {
			this._logger.debug("Handshake response", h);
			if (h.successful) {
				this._logger.debug("cometd.handshake: Connection Successful.", h);
				
			}else{
				this._logger.debug("cometd.handshake: Connection Failed.", h);
			}
		});
		// this._crossClientChannel.on(AMBConstants.REESTABLISH_SESSION, function() {
		// 	conn._reestablishSession(false);
		// });
	}

	public reload() {
		this._cometd.reload();
	}

	public abort() {
		this._cometd.getTransport().abort();
	}

	public disconnect() {
		this._logger.debug("Disconnecting from glide amb server..");
		this.disconnecting = true;
		this._cometd.disconnect();
	}

	public getURL(ambServletPath:string) {
		//return window.location.protocol + '//' + window.location.host + '/' + ambServletPath;
		return  this.getBaseUrl() + "/" + ambServletPath;
	}

	public getBaseUrl(): string {
		if (!this._instanceUrl) {
			throw new Error("Instance URL not configured. Call AMBClient.authenticate() before connect().");
		}
		return this._instanceUrl;
	}

	public getUserToken(): string {
		if (!this._userToken) {
			throw new Error("User token not configured. Call AMBClient.authenticate() before connect().");
		}
		return this._userToken;
	}

	public getSessionCookies(): string | null {
		return this._sessionCookies;
	}

	public getInstanceUrl(): string | null {
		return this._instanceUrl;
	}




	/**
	 * Connection event listeners
	 */
	 _metaHandshake(message:any) {
		//let conn:ServerConnection = this;
		this._logger.debug("_metaHandshake: message = ", message);
		const logoutOverlayStyle = this.getExt(message, AMBConstants.SESSION_LOGOUT_OVERLAY_STYLE);
		if (logoutOverlayStyle) {
			properties.instance.overlayStyle = logoutOverlayStyle;
		}
		this.sessionStatus = this.getExt(message, AMBConstants.GLIDE_SESSION_STATUS);

		this.applySubscriptionCommandFlowProperties(message);

		setTimeout(() => {
			if (message["successful"])
				this._connectionInitialized();
		}, 0);

	}

	 getExt(message:any, extensionName:string) {
		if (isObject(message.ext))
			return message.ext[extensionName];
	}

	 _getChannel(channelName:string, subscriptionOptionsCallback:any) : Channel{
		if (channelName in this.channels)
			return this.channels[channelName];

		const channel = new Channel(this, this._cometd, channelName, this.initialized, subscriptionOptionsCallback);
		this.channels[channelName] = channel;
		return channel;
	}

	 _removeChannel(channelName:any) : void{
		delete this.channels[channelName];
	}

	 applyAMBProperties(message:any) {
		this._logger.debug("applyAMBProperties: message", message);
		if (message.ext) {
			if (message.ext["glide.amb.active"] === false) {
				this.disconnect();
			}
			const logLevel = this.getExt(message, "glide.amb.client.log.level");
			if (logLevel) {
				properties.instance.logLevel = logLevel;
				this._cometd.setLogLevel(properties.instance.logLevel);
			}
		}
	}

	 _getIntMessageExtProperty(valueStr:string, defaultVal:any) {
		let propValue = Math.floor(parseInt(valueStr));
		if (isNaN(propValue) || (propValue < 0))
			propValue = defaultVal;
		return propValue;
	}

	 _getBooleanMessageExtProperty(valueStr:string, defaultVal:any) {
		let propValue = defaultVal;
		if (!isNil(valueStr)) propValue = (valueStr) ? true : false;
		return propValue;
	}

	 applySubscriptionCommandFlowProperties(message:any) {
		if (!message.ext)
			return;

		const glideAMBSubscribeCommandsFlow = message.ext["subscribeCommandsFlow"];
		if (!glideAMBSubscribeCommandsFlow)
			return;

		const subCommandFlowDefault = properties.instance.subscribeCommandsFlow;
		properties.instance.subscribeCommandsFlow.enable =
			this._getBooleanMessageExtProperty(glideAMBSubscribeCommandsFlow["enable"], subCommandFlowDefault.enable);

		if (properties.instance.subscribeCommandsFlow.enable) {
			properties.instance.subscribeCommandsFlow.retries =
				this._getIntMessageExtProperty(glideAMBSubscribeCommandsFlow["retries"], subCommandFlowDefault.retries);
			properties.instance.subscribeCommandsFlow.maxInflight =
				this._getIntMessageExtProperty(glideAMBSubscribeCommandsFlow["maxInflight"], subCommandFlowDefault.maxInflight);
			properties.instance.subscribeCommandsFlow.maxWait =
				this._getIntMessageExtProperty(glideAMBSubscribeCommandsFlow["maxWait"], subCommandFlowDefault.maxWait);

			const glideAMBRetryDelay = glideAMBSubscribeCommandsFlow["retryDelay"];
			if (glideAMBRetryDelay) {
				const retryDelayDefault = properties.instance.subscribeCommandsFlow.retryDelay;
				properties.instance.subscribeCommandsFlow.retryDelay.min =
					this._getIntMessageExtProperty(glideAMBRetryDelay["min"], retryDelayDefault.min);
				properties.instance.subscribeCommandsFlow.retryDelay.max =
					this._getIntMessageExtProperty(glideAMBRetryDelay["max"], retryDelayDefault.max);
				properties.instance.subscribeCommandsFlow.retryDelay.increaseFactor =
					this._getIntMessageExtProperty(glideAMBRetryDelay["increaseFactor"], retryDelayDefault.increaseFactor);
			}	
		}
		this._initializeSubscriptionCommandSender();
	}
	
	 _initializeSubscriptionCommandSender() {
		if (properties.instance.subscribeCommandsFlow.enable) {
			this._logger.addInfoMessage("_initializeSubscriptionCommandSender: SubscriptionCommandSender is enabled");
			if (this.tokenManagementExtension != null)
				this.tokenManagementExtension.updateTokenCount(properties.instance.subscribeCommandsFlow.maxInflight);

			if (this.subscriptionCommandSender)
				this.subscriptionCommandSender.stop();

			this.subscriptionCommandSender = new SubscriptionCommandSender(new FunctionQueue(10000), this.tokenManagementExtension);
		}

	}

	 _resubscribeAll() {
		this._logger.debug("Resubscribing to all!");
		for (const name in this.channels) {
			const channel = this.channels[name];
			try{
				
				channel && channel.resubscribeToCometD();
			}catch(err){
				this._logger.addErrorMessage("Error re-subscribing channel to cometd", {err: err, channel: channel});
			}
			
		}
	}

	 _unsubscribeAll() {
		this._logger.debug("Unsubscribing from all!");
		for (const channelName in this.channels) {
			const channel = this.channels[channelName];
			channel && channel.unsubscribeFromCometD();
		}
	}

	 _metaConnect(/*Hash*/ message:any) {
		//const conn:ServerConnection = this;
		this._logger.debug("_metaConnect: begin", message);
		this.applyAMBProperties(message);

		if (this.disconnecting) {
			setTimeout(() => {
				this.connected = false;
				this._connectionClosed();

			}, 0);
			return;
		}

		//todo: See if we need this
		const shouldTouchHttpSession = this.getExt(message, AMBConstants.TOUCH_HTTP_SESSION);
		if (this.isWebsocketTransport() && shouldTouchHttpSession === true){
			this._logger.debug("Websocket connection, calling _touchHttpSession");
			this._touchHttpSession();
		}else{
			this._logger.debug("Not websocket connection, skipping http touch session");
		}
		 	

		const error = message["error"];
		if (error){
			this._logger.addErrorMessage("Error in message.", {error: error, message: message});
			this.lastError = error;
		}
			

		this._sessionStatus(message);
		const wasConnected = this.connected;
		this.connected = (message["successful"] === true);
		if (!wasConnected && this.connected)
			this._connectionOpened();
		else if (wasConnected && !this.connected)
			this._connectionBroken();
	}

	 isWebsocketTransport() {
		return AMBConstants.WEBSOCKET_TYPE_NAME === this._cometd.getTransport().type;
	}

	 _touchHttpSession() {
		const request = new XMLHttpRequest();
		request.open("POST", this.getURL("amb"));
		request.setRequestHeader("Content-type", "application/json");
		request.send();
		this._logger.debug("_touchHttpSession", request);
	}

	 _connectionInitialized() {
		this._logger.debug("Connection initialized");
		this.initialized = true;
		this.state = "initialized";
		this._publishEvent(this.eventManager.getEvents().CONNECTION_INITIALIZED);
	}


	 _connectionOpened() {
		this._logger.debug("_connectionOpened: Connection opened", {needToReestablishSession:this.needToReestablishSession});

		if (this.needToReestablishSession) {
			this._setupSession();
		} else {
			this.channelRedirect.initialize(this._onChannelRedirectSubscriptionComplete);
			this._onChannelRedirectSubscriptionComplete();
		}

	}

	 _onChannelRedirectSubscriptionComplete() {
		this._resubscribeAll();
		this.state = "opened";
		this._publishEvent(this.eventManager.getEvents().CONNECTION_OPENED);
	}

	 _setupSession() {
		this._logger.debug("_setupSession: ", {ambServerConnection:this});
		if (this.getLastError() !== this.getErrorMessages().UNKNOWN_CLIENT)
			return;

		this.setLastError(null);
		this._sendRequestToSetUpGlideSession((status:any) =>{
			this._logger.debug("ambServerConnection._sendSessionSetupRequest callback", {status:status});
			if (status !== 200)
				return;

			this.needToReestablishSession = false;
			this.channelRedirect.initialize(this._onChannelRedirectSubscriptionComplete);
		});
	}
	private _defaultCallback(status:any):void { this._logger.warn("Empty callback.", status); }

	 _sendRequestToSetUpGlideSession(callback:Function = this._defaultCallback) : void {
		// We are reconnected, but the GlideSession may not have been set up. We currently do not support
		// re-establishing a connection from an AMB message (CometD 2.X does not support asynchronous
		// request handling).
		const xhr = this._buildSetUpSessionRequest();
		xhr.onload = () => callback(xhr);
		xhr.send();
	}

	 _buildSetUpSessionRequest():any {
		this._logger.debug("sending /amb_session_setup.do!");

		const request = new XMLHttpRequest();
		const url:string = this.getBaseUrl() + "/" + "/amb_session_setup.do";
		request.open("POST", url);
		request.setRequestHeader("Content-type", "application/json;charset=UTF-8");
		//todo: Setup getting g_ck if we need it? We are going to handle the session elsewhere
		request.setRequestHeader("X-UserToken",this.getUserToken());
		request.setRequestHeader("X-CometD_SessionID", this._cometd.getClientId());

		return request;
	}

	 _connectionClosed() {
		this._logger.debug("Connection closed");
		this.state = "closed";
		this._publishEvent(this.eventManager.getEvents().CONNECTION_CLOSED);
	}

	 _connectionBroken() {
		this._logger.addErrorMessage("Connection broken");
		this.state = "broken";
		this.needToReestablishSession = true;
		this._publishEvent(this.eventManager.getEvents().CONNECTION_BROKEN);
		this._stopSubscriptionCommandSender();
	}
	
	 _stopSubscriptionCommandSender() {
		if (this.subscriptionCommandSender) {
			this.subscriptionCommandSender.stop();
			this.subscriptionCommandSender = null;
		}
	}


	
/**
	 * Session management/maintenance
	 */

	_sessionStatus(/*Hash*/ message:any) {
		const newSessionStatus = this.getExt(message, AMBConstants.GLIDE_SESSION_STATUS);
		if (!newSessionStatus || newSessionStatus === this.sessionStatus)
			return;

		this.loginWindowOverride = this.getExt(message, "glide.amb.login.window.override") === true;
		this._processSessionStatus(newSessionStatus);
	}

	_processSessionStatus(newSessionStatus:any) {
		this._logger.debug("session.status - " + newSessionStatus);
		if (this.isSessionInvalidated(newSessionStatus)) {
			this._invalidated();
		} else if (this.isLoggedOut(newSessionStatus)) {
			this._loggedOut();
		} else if (this.isReestablished(newSessionStatus)) {
			this._reestablished();
		} else if (this._isLoggedIn(newSessionStatus)) {
			this._loggedIn();
		}
		this.sessionStatus = newSessionStatus;
	}

	 _isLoggedIn(newSessionStatus:any) {
		return (this.sessionStatus === ServerConnection.sessionStates.SESSION_INVALIDATED || this.sessionStatus === ServerConnection.sessionStates.SESSION_LOGGED_OUT)
			&& newSessionStatus === ServerConnection.sessionStates.SESSION_LOGGED_IN;
	}

	 isLoggedOut(newSessionStatus:any) {
		return this.sessionStatus === ServerConnection.sessionStates.SESSION_LOGGED_IN && newSessionStatus === ServerConnection.sessionStates.SESSION_LOGGED_OUT;
	}

	 isReestablished(newSessionStatus:any) {
		return this.sessionStatus === ServerConnection.sessionStates.SESSION_INVALIDATED && newSessionStatus === ServerConnection.sessionStates.SESSION_LOGGED_OUT;
	}

	/**
	 * For logged in users session invalidation happens instead of being logged out when they have remember me on
	 */
	 isSessionInvalidated(newSessionStatus:any) {
		return (this.sessionStatus === ServerConnection.sessionStates.SESSION_LOGGED_IN || this.sessionStatus === ServerConnection.sessionStates.SESSION_LOGGED_OUT)
			&& newSessionStatus === ServerConnection.sessionStates.SESSION_INVALIDATED;
	}

	 _loggedIn() {
		this._logger.debug("LOGGED_IN event fire!");
		this._resubscribeAll();
		this._publishEvent(this.eventManager.getEvents().SESSION_LOGGED_IN);
		this.loginHide();
	}

	 _loggedOut() {
		this._logger.debug("LOGGED_OUT event fire!");
		this._unsubscribeAll();
		this._publishEvent(this.eventManager.getEvents().SESSION_LOGGED_OUT);

		if (this.loginWindowEnabled && !this.loginWindowOverride) {
			this.loginShow();
		}
	}

	 _reestablished() {
		this._logger.debug("REESTABLISHED event fire!");
		this._resubscribeAll();
		this._publishEvent(this.eventManager.getEvents().SESSION_REESTABLISHED);
	}

	 _invalidated() {
		this._logger.debug("INVALIDATED event fire!");
		this._unsubscribeAll();
		this._publishEvent(this.eventManager.getEvents().SESSION_INVALIDATED);
	}

	 _publishEvent(event:any) {
		try {
			this.eventManager.publish(event);
		} catch (e) {
			this._logger.addErrorMessage("error publishing '" + event + "' - " + e);
		}
	}

	 _emitReestablishSession() {
		this._crossClientChannel.emit(AMBConstants.REESTABLISH_SESSION, AMBConstants.REESTABLISH_SESSION);
	}

	/**
	 * Channel management
	 */
	unsubscribeAll() {
		this._unsubscribeAll();
	}

	resubscribeAll() {
		this._resubscribeAll();
	}

	removeChannel(/*String*/channelName:any) {
		this._removeChannel(channelName);
	}

	/**
	 * Connection event management
	 */

	getEvents() {
		return this.eventManager.getEvents();
	}

	getConnectionState() {
		return this.state;
	}

	getLastError() {
		return this.lastError;
	}

	setLastError(/*String*/error:any) {
		this.lastError = error;
	}

	getErrorMessages() {
		return this.errorMessages;
	}

	isLoggedIn() {
		return this.sessionStatus === ServerConnection.sessionStates.SESSION_LOGGED_IN;
	}

	isSessionActive() {
		return this.sessionStatus !== ServerConnection.sessionStates.SESSION_INVALIDATED;
	}

	getChannelRedirect() {
		return this.channelRedirect;
	}

	public getChannel(channelName:string, subscriptionOptionsCallback?:Function) : Channel{
		return this._getChannel(channelName, subscriptionOptionsCallback);
	}

	getChannels() {
		return this.channels;
	}

	getState() {
		return this.state;
	}

	getLoginWindowOverlayStyle() {
		return properties.instance.overlayStyle;
	}

	loginShow() {
		this._logger.debug("Show login window");
		// noinspection HtmlUnknownTarget
		const modalContent = "<iframe src=\"/amb_login.do\" frameborder=\"0\" height=\"400px\" width=\"405px\" scrolling=\"no\"></iframe>";

		const modalTemplate =
			`<div id="amb_disconnect_modal" tabindex="-1" aria-hidden="true" class="modal" role="dialog" style="${properties.instance.overlayStyle}">
				<div class="modal-dialog small-modal" style="width:450px">
				   <div class="modal-content">
					  <header class="modal-header">
						 <h4 id="small_modal1_title" class="modal-title">Login</h4>
					  </header>
					  <div class="modal-body">
					  </div>
				   </div>
				</div>
			</div>`;

		// Protect against GlideModal not being defined
		try {
			// const dialog = new GlideModal('amb_disconnect_modal');
			// // on older browsers the class has a different api
			// if (dialog['renderWithContent']) {
			// 	dialog.template = modalTemplate;
			// 	dialog.renderWithContent(modalContent);
			// } else {
			// 	dialog.setBody(modalContent);
			// 	dialog.render();
			// }
			// loginWindow = dialog;
		} catch (e) {
			//this._logger.debug(e);
		}
	}

	loginHide() {
		// if (!loginWindow)
		// 	return;

		// loginWindow.destroy();
		// loginWindow = null;
	}

	loginComplete() {
		//ambServerConnection.reestablishSession();
	}

	_reestablishSession(emit:boolean) {
		this._sendRequestToSetUpGlideSession((response:any) =>{
			if (!response)
				return;

			const status = JSON.parse(response)["glide.session.status"];
			this._processSessionStatus(status);
		});

		// if (emit)
		// 	this._emitReestablishSession();
	}

	reestablishSession() {
		this._reestablishSession(true);
	}

	subscribeToEvent(/*String*/ event:any, /*Function*/ callback:any) : number{
		// If we're already connected, and someone subscribes to the connection opened
		// event, just fire their callback
		if (this.eventManager.getEvents().CONNECTION_OPENED === event && this.connected)
			callback();

		return this.eventManager.subscribe(event, callback);
	}

	unsubscribeFromEvent(/*Number*/ id:number) {
		this.eventManager.unsubscribe(id);
	}

	isLoginWindowEnabled() : boolean {
		return this.loginWindowEnabled;
	}

	setLoginWindowEnabled(enableLoginWindow:boolean) {
		this.loginWindowEnabled = enableLoginWindow;
	}

	isLoginWindowOverride() {
		return this.loginWindowOverride;
	}

	getSubscriptionCommandSender() {
		return this.subscriptionCommandSender;	
	}

	// /* These are for testing, do not use. */
	// ambServerConnection._metaConnect = _metaConnect;
	// ambServerConnection._metaHandshake = _metaHandshake;
	// ambServerConnection._sendSessionSetupRequest = _sendRequestToSetUpGlideSession;
	// ambServerConnection._onChannelRedirectSubscriptionComplete = _onChannelRedirectSubscriptionComplete;
	// ambServerConnection._getChannel = _getChannel;
	// ambServerConnection._removeChannel = _removeChannel;
	// ambServerConnection._connectionInitialized = _connectionInitialized;
	// ambServerConnection._connectionOpened = _connectionOpened;
	// ambServerConnection._reestablishSession = _reestablishSession;
	// ambServerConnection._touchHttpSession = _touchHttpSession;

}
