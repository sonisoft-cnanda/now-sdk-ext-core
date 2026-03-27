/* eslint-disable @typescript-eslint/ban-types */
import {MessageClient, SubscriptionConfig} from "./MessageClient";
import Base64 from "crypto-js/enc-base64.js";
import Utf8 from "crypto-js/enc-utf8.js";
import {Logger} from "../../util/Logger";
import { ServerConnection } from "./ServerConnection";
import { ChannelListener } from "./ChannelListener";
import { ServiceNowInstance } from "../ServiceNowInstance";
import { SessionManager } from "../../comm/http/SessionManager";
import { HTTPRequest } from "../../comm/http/HTTPRequest";


export class AMBClient{

    _clientSubscriptions:any;
    _logger:Logger;
    _ambClient:MessageClient;
    _serverConnection:ServerConnection;
    initiatedConnection = false;
    private _instance: ServiceNowInstance | null = null;
    private _authenticated: boolean = false;

    constructor(clientSubscriptions:any, instance?: ServiceNowInstance){
        this._logger = new Logger("AMBClient");
		this._ambClient = new MessageClient();
		this._clientSubscriptions = clientSubscriptions;
		this._instance = instance || null;

		this._serverConnection = this._ambClient.getServerConnection();
        this._serverConnection.setLoginWindowEnabled(false);
		
    }

    /**
     * Authenticate and obtain session cookies from ServiceNow
     * This must be called before connect() to ensure valid session cookies
     */
    public async authenticate(): Promise<void> {
        if (!this._instance) {
            this._logger.warn("No ServiceNow instance configured. Skipping authentication.");
            return;
        }

        this._logger.info("Authenticating to ServiceNow to obtain session cookies...");

        try {
            // Get or create a ServiceNow request via SessionManager (reused across components)
            const snRequest = SessionManager.getInstance().getRequest(this._instance);
            
            // Get the session which triggers login
            const session: any = await snRequest.getUserSession();
            
            this._logger.debug("Session obtained", { sessionKeys: Object.keys(session) });
            
            // Extract instance URL from session
            let instanceUrl = this._instance.getHost();
            if (!instanceUrl && session) {
                // Try to get from session/credential
                instanceUrl = this.extractInstanceUrl(session);
            }
            
            if (instanceUrl) {
                this._serverConnection.setInstanceUrl(instanceUrl);
                this._logger.info(`Instance URL configured: ${instanceUrl}`);
            } else {
                this._logger.warn("Could not determine instance URL");
            }
            
            // Extract cookies from session
            // Session has structure: {type, instanceUrl, cookie, userToken}
            this._logger.debug("Session obtained", { sessionKeys: Object.keys(session) });
            
            let cookieString: string | null = null;
            
            // The session.cookie property contains the CookieJar from tough-cookie
            if (session && session.cookie) {
                this._logger.debug("Found session.cookie (CookieJar)");
                
                // Try to get cookie string from the CookieJar
                // The SDK's session.cookie is a tough-cookie CookieJar
                const cookieJar = session.cookie;
                
                // Method 1: Try getCookieStringSync if available
                if (typeof cookieJar.getCookieStringSync === 'function') {
                    try {
                        cookieString = cookieJar.getCookieStringSync(instanceUrl);
                        this._logger.debug(`Extracted cookies via getCookieStringSync: ${cookieString?.substring(0, 80)}...`);
                    } catch (e) {
                        this._logger.debug(`getCookieStringSync failed: ${e}`);
                    }
                }
                
                // Method 2: Try async getCookieString
                if (!cookieString && typeof cookieJar.getCookieString === 'function') {
                    try {
                        cookieString = await cookieJar.getCookieString(instanceUrl);
                        this._logger.debug(`Extracted cookies via getCookieString: ${cookieString?.substring(0, 80)}...`);
                    } catch (e) {
                        this._logger.debug(`getCookieString failed: ${e}`);
                    }
                }
                
                // Method 3: Try getCookiesSync and manually format
                if (!cookieString && typeof cookieJar.getCookiesSync === 'function') {
                    try {
                        const cookies = cookieJar.getCookiesSync(instanceUrl);
                        if (cookies && cookies.length > 0) {
                            cookieString = cookies.map((c: any) => `${c.key}=${c.value}`).join('; ');
                            this._logger.debug(`Extracted ${cookies.length} cookies via getCookiesSync`);
                        }
                    } catch (e) {
                        this._logger.debug(`getCookiesSync failed: ${e}`);
                    }
                }
                
                // Method 4: Access the store directly
                if (!cookieString) {
                    cookieString = this.extractCookiesFromStore(cookieJar, instanceUrl);
                }
            }
            
            // Also try to get user token from session
            if (session && session.userToken) {
                this._serverConnection.setUserToken(session.userToken);
                this._logger.debug("User token extracted from session");
            }
            
            if (cookieString) {
                this._serverConnection.setSessionCookies(cookieString);
                this._authenticated = true;
                this._logger.info("Successfully authenticated and obtained session cookies");
                this._logger.debug(`Cookies: ${cookieString.substring(0, 100)}...`);
            } else {
                this._logger.error("Could not extract session cookies!");
                this._logger.debug("Session structure", { 
                    sessionType: typeof session,
                    sessionKeys: Object.keys(session),
                    hasCookie: !!session?.cookie,
                    cookieJarType: session?.cookie ? typeof session.cookie : 'N/A',
                    cookieJarMethods: session?.cookie ? Object.getOwnPropertyNames(Object.getPrototypeOf(session.cookie)) : []
                });
                throw new Error("Failed to extract session cookies for AMB connection");
            }
        } catch (error) {
            this._logger.error(`Authentication failed: ${error}`);
            throw new Error(`Failed to authenticate for AMB connection: ${error}`);
        }
    }

    /**
     * Extract instance URL from session or credential
     */
    private extractInstanceUrl(session: any): string | null {
        try {
            // Try various ways to get instance URL
            if (session.instanceUrl) return session.instanceUrl;
            if (session.instance) return session.instance;
            if (session.host) return session.host;
            
            // Try to get from credential
            const cred: any = this._instance?.credential;
            if (cred) {
                if (cred.instanceUrl) return cred.instanceUrl;
                if (cred.instance) return cred.instance;
                if (cred.host) return cred.host;
                
                // May be nested in credentials property
                if (cred.credentials) {
                    const nestedCred = cred.credentials;
                    if (nestedCred.instanceUrl) return nestedCred.instanceUrl;
                    if (nestedCred.instance) return nestedCred.instance;
                    if (nestedCred.host) return nestedCred.host;
                }
            }
            
            // Try getting from alias (construct URL)
            const alias = this._instance?.getAlias();
            if (alias) {
                // Common pattern: alias is the instance name
                return `https://${alias}.service-now.com`;
            }
        } catch (e) {
            this._logger.debug(`Error extracting instance URL: ${e}`);
        }
        
        return null;
    }

    /**
     * Extract cookies from cookie store and format for WebSocket headers
     */
    private extractCookiesFromStore(cookieStore: any, instanceUrl: string | null): string | null {
        try {
            if (!cookieStore) return null;
            
            // Get all cookies from the store
            const cookies: string[] = [];
            
            // The cookie store from SDK has a getAllCookies or similar method
            if (typeof cookieStore.getAllCookies === 'function') {
                const allCookies = cookieStore.getAllCookies();
                this._logger.debug(`Found ${allCookies.length} cookies via getAllCookies`);
                allCookies.forEach((cookie: any) => {
                    // Only include key=value, not Set-Cookie directives
                    cookies.push(`${cookie.key}=${cookie.value}`);
                });
            } else if (typeof cookieStore.getCookies === 'function') {
                const domain = instanceUrl ? new URL(instanceUrl).hostname : null;
                this._logger.debug(`Getting cookies for domain: ${domain}`);
                if (!domain) {
                    this._logger.warn("No domain available for cookie extraction");
                    return null;
                }
                const domainCookies = cookieStore.getCookies(domain);
                if (Array.isArray(domainCookies)) {
                    this._logger.debug(`Found ${domainCookies.length} cookies for domain`);
                    domainCookies.forEach((cookie: any) => {
                        // Only include key=value, not Set-Cookie directives  
                        cookies.push(`${cookie.key}=${cookie.value}`);
                    });
                }
            } else {
                // Try to access cookies directly
                this._logger.debug("Cookie store type", { 
                    type: typeof cookieStore,
                    methods: Object.keys(cookieStore),
                    cookieStore: cookieStore
                });
                
                // If it's a CookieJar, try to get cookies directly
                if (cookieStore.store && cookieStore.store.idx) {
                    const idx = cookieStore.store.idx;
                    for (const domain in idx) {
                        for (const path in idx[domain]) {
                            for (const key in idx[domain][path]) {
                                const cookie = idx[domain][path][key];
                                cookies.push(`${cookie.key}=${cookie.value}`);
                            }
                        }
                    }
                    this._logger.debug(`Extracted ${cookies.length} cookies from CookieJar store`);
                }
            }
            
            if (cookies.length > 0) {
                const cookieString = cookies.join('; ');
                this._logger.debug(`Final cookie string length: ${cookieString.length}`);
                return cookieString;
            } else {
                this._logger.warn("No cookies extracted from store");
            }
        } catch (e) {
            this._logger.error(`Error extracting cookies from store: ${e}`);
        }
        
        return null;
    }

    /**
     * Check if the client has been authenticated
     */
    public isAuthenticated(): boolean {
        return this._authenticated;
    }

    getServerConnection() {
        return this._serverConnection;
    }

    connect() {
        this._ambClient.connect();
    }

    abort() {
        this._ambClient.abort();
    }

    disconnect() {
        this._ambClient.disconnect();
    }

    getConnectionState() {
        return this._ambClient.getConnectionState();
    }

    getState() {
        return this._ambClient.getConnectionState();
    }

    getClientId() {
        return this._ambClient.getClientId();
    }

    getChannel(channelName:string, subscriptionConfig:any) : ChannelListener  {
        //const client:AMBClient = this;
        this._logger.debug("buildClient.getChannel: channelName = " + channelName);
        const channel = this._ambClient.getChannel(channelName, subscriptionConfig);
        const originalSubscribe = channel.subscribe;
        const originalUnsubscribe = channel.unsubscribe;

        channel.subscribe = (listener: any) => {
            this._clientSubscriptions.add(channel, listener, function () {
                channel.unsubscribe(listener);
            });

            // windowContext.addEventListener('unload', function() {
            // 	ambClient.removeChannel(channelName);
            // });
            originalSubscribe.call(channel, listener);
            return channel;
        };

        channel.unsubscribe = (listener: any) => {
            this._clientSubscriptions.remove(channel, listener);
            const call = originalUnsubscribe.call(channel, listener);
            if (this._serverConnection.getChannel(channelName).getChannelListeners().length === 0) {
                this._ambClient.removeChannel(channelName);
            }
            return call;
        };

        return channel;
    }

    getChannel0(channelName:string, subscriptionCallback:Function) : ChannelListener {
        const config:SubscriptionConfig = {subscriptionCallback:subscriptionCallback};
        return this._ambClient.getChannel(channelName, config);
    }

    /**
     * Creates a channel with a properly encoded name required for Record Watcher. Returns a channel listener.
     *
     * @param {string} table
     * @param {string} query
     * @param {string} actionPrefix
     * @param {Object<*>} subscriptionConfig
     * @param {Object<*>} windowContext
     * @returns {*|amb.ChannelListener}
     */
    getRecordWatcherChannel(table:string, query:string, actionPrefix:string | null, subscriptionConfig:SubscriptionConfig) {
        // replace base64 padding character due to '=' is invalid channel name
        const base64EncodedQuery = Base64.stringify(Utf8.parse(query)).replace(/=/g, "-");
        actionPrefix = actionPrefix || "default";

        return this.getChannel("/rw/" + actionPrefix + "/" + table + "/" + base64EncodedQuery, subscriptionConfig);
    }

    registerExtension(/*String*/ extensionName:string, /*Object*/ extension:any) {
        this._ambClient.registerExtension(extensionName, extension);
    }

    unregisterExtension(extensionName:string) {
        this._ambClient.unregisterExtension(extensionName);
    }

    batch(block:Function) {
        this._ambClient.batch(block);
    }

    subscribeToEvent(event:string, callback:Function) {
       
        const id =  this._ambClient.subscribeToEvent(event, callback);
        this._clientSubscriptions.add(id, true, () => {
                this._ambClient.unsubscribeFromEvent(id);
            });
        return id;
    }

    unsubscribeFromEvent(id:number, windowContext:any) {
        this._clientSubscriptions.remove(id, true);
        this._ambClient.unsubscribeFromEvent(id);
    }

    isLoggedIn():boolean {
        return this._ambClient.isLoggedIn();
    }

    getConnectionEvents() {
        return this._ambClient.getConnectionEvents();
    }

    getEvents() {
        return this._ambClient.getConnectionEvents();
    }

    reestablishSession() {
        this._ambClient.reestablishSession();
    }

    loginComplete() {
        this._ambClient.loginComplete();
    }

    getChannels() {
        return this._ambClient.getChannels();
    }

    extendSession() {
        return this._ambClient.extendSession();
    }

    getTokenManagementExtension() {
        return this._ambClient.getTokenManagementExtension();
    }

    public onProcessEnd(...args: any[]){
        this.disconnect();
    }


}