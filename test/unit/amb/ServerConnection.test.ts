/**
 * Unit tests for ServerConnection credential validation
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServerConnection } from '../../../src/sn/amb/ServerConnection';
import { AMBConstants } from '../../../src/sn/amb/AMBConstants';

function createMockCometd() {
    return {
        getExtension: jest.fn().mockReturnValue(null),
        addListener: jest.fn(),
        configure: jest.fn(),
        handshake: jest.fn(),
        disconnect: jest.fn(),
        getTransport: jest.fn().mockReturnValue({ type: 'websocket', abort: jest.fn() }),
        getClientId: jest.fn().mockReturnValue('test-client-id'),
    };
}

describe('ServerConnection', () => {
    let serverConnection: ServerConnection;
    let mockCometd: ReturnType<typeof createMockCometd>;

    beforeEach(() => {
        mockCometd = createMockCometd();
        serverConnection = new ServerConnection(mockCometd);
    });

    describe('credential validation', () => {
        it('throws when connect() called without session cookies', () => {
            serverConnection.setInstanceUrl('https://test.service-now.com');
            serverConnection.setUserToken('test-token');
            // session cookies not set

            expect(() => serverConnection.connect()).toThrow(
                /session cookies/i
            );
        });

        it('throws when getBaseUrl() called without instance URL', () => {
            // instance URL not set
            expect(() => serverConnection.getBaseUrl()).toThrow(
                /instance URL/i
            );
        });

        it('throws when getUserToken() called without user token', () => {
            // user token not set
            expect(() => serverConnection.getUserToken()).toThrow(
                /user token/i
            );
        });

        it('connects successfully when all credentials are set', () => {
            serverConnection.setInstanceUrl('https://test.service-now.com');
            serverConnection.setSessionCookies('JSESSIONID=abc123');
            serverConnection.setUserToken('test-token');

            // Should not throw
            serverConnection.connect();

            expect(mockCometd.configure).toHaveBeenCalled();
            expect(mockCometd.handshake).toHaveBeenCalled();
        });
    });

    describe('public getters', () => {
        it('getSessionCookies returns set value', () => {
            serverConnection.setSessionCookies('JSESSIONID=abc123');
            expect(serverConnection.getSessionCookies()).toBe('JSESSIONID=abc123');
        });

        it('getSessionCookies returns null when not set', () => {
            expect(serverConnection.getSessionCookies()).toBeNull();
        });

        it('getInstanceUrl returns set value', () => {
            serverConnection.setInstanceUrl('https://test.service-now.com');
            expect(serverConnection.getInstanceUrl()).toBe('https://test.service-now.com');
        });

        it('getInstanceUrl returns null when not set', () => {
            expect(serverConnection.getInstanceUrl()).toBeNull();
        });

        it('getBaseUrl returns instance URL when set', () => {
            serverConnection.setInstanceUrl('https://test.service-now.com');
            expect(serverConnection.getBaseUrl()).toBe('https://test.service-now.com');
        });

        it('getUserToken returns set value', () => {
            serverConnection.setUserToken('my-token');
            expect(serverConnection.getUserToken()).toBe('my-token');
        });
    });
});
