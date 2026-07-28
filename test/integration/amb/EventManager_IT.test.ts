import { Mock, mock } from "ts-jest-mocker";
import {EventManager} from "../../../src/sn/amb/EventManager";

describe.skip('EventManager', () => {
	const events = {
		CONNECTION_INITIALIZED: 'connection.initialized',
		CONNECTION_OPENED: 'connection.opened',
		CONNECTION_CLOSED: 'connection.closed',
		CONNECTION_BROKEN: 'connection.broken',
		SESSION_LOGGED_IN: 'session.logged.in',
		SESSION_LOGGED_OUT: 'session.logged.out',
		SESSION_INVALIDATED: 'session.invalidated'
	};

	type Callback = {
		callback1:Function,
		callback2:Function
	}

	//let cbMObj:callbackMock = {callback1: () => {}, callback2: () => {}} as callbackMock;

	let cbMock: any;

	cbMock = mock<Callback>();

	cbMock.callback1.mockImplementation(() => {});
	cbMock.callback2.mockImplementation(() => {});
	

	describe('subscribe', () => {
		it('registers callbacks for an event', () => {
			const testEventManager = new EventManager(events);
			expect(testEventManager.subscribe(events.CONNECTION_INITIALIZED, cbMock.callback1)).toBe(0);
			expect(testEventManager.subscribe(events.CONNECTION_INITIALIZED, cbMock.callback2)).toBe(1);
			//expect(testEventManager._getSubscriptions(events.CONNECTION_INITIALIZED,).length).toBe(2);
		});
	});

	describe('unsubscribe', () => {
		it('removes a callback for an event', () => {
			const testEventManager = new EventManager(events);
			expect(testEventManager.subscribe(events.CONNECTION_INITIALIZED, cbMock.callback1)).toBe(0);
			expect(testEventManager.subscribe(events.CONNECTION_INITIALIZED, cbMock.callback2)).toBe(1);

			testEventManager.unsubscribe(1);

			//expect(testEventManager._getSubscriptions(events.CONNECTION_INITIALIZED,).length).toBe(1);
		});
	});

	describe('publish', () => {
		it('calls registered callback for event', () => {
			const testEventManager = new EventManager(events);
			expect(testEventManager.subscribe(events.CONNECTION_INITIALIZED, cbMock.callback1)).toBe(0);
			expect(testEventManager.subscribe(events.CONNECTION_OPENED, cbMock.callback2)).toBe(1);

			testEventManager.publish(events.CONNECTION_INITIALIZED, ['success']);

			expect(cbMock.callback1).toHaveBeenCalledWith('success');
			expect(cbMock.callback2).toHaveBeenCalledTimes(0);
		});
	});

	describe('getEvents', () => {
		it('returns events', () => {
			const testEventManager = new EventManager(events);
			expect(testEventManager.getEvents()).toEqual(events);
		});
	});
});