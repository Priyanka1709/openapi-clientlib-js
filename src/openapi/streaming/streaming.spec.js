import {
    installClock,
    uninstallClock,
    tick,
    setTimeout,
    getResolvablePromise,
} from '../../test/utils';
import mockTransport from '../../test/mocks/transport';
import mockMathRandom from '../../test/mocks/math-random';
import log from '../../log';
import mockAuthProvider from '../../test/mocks/authProvider';
import mockFetch from '../../test/mocks/fetch';
import Streaming, { findRetryDelay } from './streaming';
import * as connectionConstants from './connection/constants';
import * as streamingTransports from './connection/transportTypes';

describe('openapi Streaming', () => {
    let stateChangedCallback;
    let connectionSlowCallback;
    let startCallback;
    let receivedCallback;
    let errorCallback;
    let authProvider;
    let mockConnection;
    let subscriptionUpdateSpy;
    let subscriptionErrorSpy;
    let transport;
    let fetchMock;

    const legacySignalrConnectionState = {
        connecting: 0,
        connected: 1,
        reconnecting: 2,
        disconnected: 4,
    };

    beforeEach(() => {
        mockConnection = {
            stateChanged: jest.fn(),
            start: jest.fn(),
            received: jest.fn(),
            error: jest.fn(),
            connectionSlow: jest.fn(),
            stop: jest.fn(),
        };
        mockConnection.stateChanged.mockImplementation((callback) => {
            stateChangedCallback = callback;
        });
        mockConnection.start.mockImplementation((options, callback) => {
            startCallback = callback;
        });
        mockConnection.received.mockImplementation((callback) => {
            receivedCallback = callback;
        });
        mockConnection.error.mockImplementation((callback) => {
            errorCallback = callback;
        });
        mockConnection.connectionSlow.mockImplementation((callback) => {
            connectionSlowCallback = callback;
        });

        global.$ = {
            connection: jest.fn().mockReturnValue(mockConnection),
            signalR: {
                connectionState: legacySignalrConnectionState,
            },
        };

        transport = mockTransport();
        authProvider = mockAuthProvider();

        subscriptionUpdateSpy = jest.fn().mockName('subscriptionUpdate');
        subscriptionErrorSpy = jest.fn().mockName('subscriptionError');

        fetchMock = mockFetch();

        installClock();
        mockMathRandom();
    });
    afterEach(() => uninstallClock());

    function mockSubscription() {
        function changeState(state) {
            this.stateChangedCallback.forEach((callback) => callback(state));
        }

        function addStateChangedCallback(callback) {
            this.stateChangedCallback.push(callback);
        }

        function removeStateChangedCallback(callback) {
            const index = this.stateChangedCallback.indexOf(callback);
            if (index > -1) {
                this.stateChangedCallback.splice(index, 1);
            }
        }

        return {
            stateChangedCallback: [],
            changeState,
            onStreamingData: jest.fn(),
            onHeartbeat: jest.fn(),
            onConnectionUnavailable: jest.fn(),
            onConnectionAvailable: jest.fn(),
            reset: jest.fn(),
            onSubscribe: jest.fn(),
            onUnsubscribe: jest.fn(),
            onModify: jest.fn(),
            dispose: jest.fn(),
            timeTillOrphaned: jest.fn(),
            addStateChangedCallback,
            removeStateChangedCallback,
        };
    }

    describe('init', () => {
        it('initializes the connection', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);

            expect(global.$.connection).toHaveBeenCalledTimes(1);
            expect(global.$.connection.mock.calls[0]).toEqual([
                'testUrl/streaming/connection',
            ]);
            expect(streaming.getQuery()).toEqual(
                'authorization=Bearer%20TOKEN&context=0000000000',
            );
            expect(mockConnection.start).toHaveBeenCalledTimes(1);
        });

        it('waits for the authentication token to be valid', () => {
            authProvider.getExpiry.mockImplementation(() => Date.now() - 1);
            const streaming = new Streaming(transport, 'testUrl', authProvider);

            expect(mockConnection.start).toHaveBeenCalledTimes(0);
            expect(authProvider.one).toHaveBeenCalledTimes(1);

            // change the token and expiry and call the one callback
            authProvider.getExpiry.mockImplementation(() => Date.now() + 1000);
            authProvider.getToken.mockImplementation(() => 'Bearer NEWTOKEN');
            authProvider.one.mock.calls[0][1]();

            expect(mockConnection.start).toHaveBeenCalledTimes(1);
            expect(streaming.getQuery()).toEqual(
                'authorization=Bearer%20NEWTOKEN&context=0000000000',
            );
        });
    });

    describe('network issues', () => {
        it('calls through', () => {
            // these calls are ignored for signal-r
            const streaming = new Streaming(
                transport,
                'testUrl',
                authProvider,
                {},
            );

            const subscription = streaming.createSubscription(
                'root',
                '/test/test',
                {},
                subscriptionUpdateSpy,
                subscriptionErrorSpy,
            );

            expect(() => {
                subscription.onNetworkError();
            }).not.toThrow();

            expect(() => {
                streaming.orphanFinder.onOrphanFound(subscription);
            }).not.toThrow();
        });
    });

    describe('findRetryDelay', () => {
        it('find delay for level 0', () => {
            const mockedLevels = [
                { level: 0, delay: 1000 },
                { level: 1, delay: 2000 },
                { level: 5, delay: 5000 },
            ];

            const defaultDelay = 500;
            const result = findRetryDelay(mockedLevels, 0, defaultDelay);

            expect(result).toBe(1000);
        });

        it('find delay for level 1', () => {
            const mockedLevels = [
                { level: 0, delay: 1000 },
                { level: 1, delay: 2000 },
                { level: 5, delay: 5000 },
            ];

            const defaultDelay = 500;
            const result = findRetryDelay(mockedLevels, 1, defaultDelay);

            expect(result).toBe(2000);
        });

        it('find delay for level 4 in between two setup levels', () => {
            const mockedLevels = [
                { level: 0, delay: 1000 },
                { level: 1, delay: 2000 },
                { level: 5, delay: 5000 },
            ];

            const defaultDelay = 500;
            const result = findRetryDelay(mockedLevels, 4, defaultDelay);

            expect(result).toBe(2000);
        });

        it('find delay for level 5', () => {
            const mockedLevels = [
                { level: 0, delay: 1000 },
                { level: 1, delay: 2000 },
                { level: 5, delay: 5000 },
            ];

            const defaultDelay = 500;
            const result = findRetryDelay(mockedLevels, 5, defaultDelay);

            expect(result).toBe(5000);
        });

        it('find delay for retry index of 6', () => {
            const mockedLevels = [
                { level: 0, delay: 1000 },
                { level: 1, delay: 2000 },
                { level: 5, delay: 5000 },
            ];

            const defaultDelay = 500;
            const result = findRetryDelay(mockedLevels, 6, defaultDelay);

            expect(result).toBe(5000);
        });

        it('find delay for retry index of 100', () => {
            const mockedLevels = [
                { level: 0, delay: 1000 },
                { level: 1, delay: 2000 },
                { level: 5, delay: 5000 },
            ];

            const defaultDelay = 500;
            const result = findRetryDelay(mockedLevels, 100, defaultDelay);

            expect(result).toBe(5000);
        });

        it('return default delay if list of levels is empty', () => {
            const mockedLevels = [];

            const defaultDelay = 500;
            const result = findRetryDelay(mockedLevels, 0, defaultDelay);

            expect(result).toBe(500);
        });

        it('return default delay if list of levels is missing specific level', () => {
            const mockedLevels = [{ level: 2, delay: 5000 }];

            const defaultDelay = 500;
            const result = findRetryDelay(mockedLevels, 0, defaultDelay);

            expect(result).toBe(500);
        });
    });

    describe('connection states', () => {
        let streaming;
        let subscription;
        let stateChangedSpy;

        function givenStreaming(options) {
            streaming = new Streaming(
                transport,
                'testUrl',
                authProvider,
                options,
            );
            subscription = streaming.createSubscription(
                'root',
                '/test/test',
                {},
                subscriptionUpdateSpy,
                subscriptionErrorSpy,
            );
            subscription.onConnectionAvailable = jest
                .fn()
                .mockName('onConnectionAvailable');
            subscription.onConnectionUnavailable = jest
                .fn()
                .mockName('onConnectionUnavailable');
            subscription.reset = jest.fn().mockName('reset');
            subscription.dispose = jest.fn().mockName('dispose');
            stateChangedSpy = jest.fn().mockName('stateChanged');
            streaming.on('connectionStateChanged', stateChangedSpy);
            return streaming;
        }

        it('is initially initialising', () => {
            streaming = new Streaming(transport, 'testUrl', authProvider);
            expect(streaming.retryCount).toBe(0);
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_INITIALIZING,
            );
        });

        it('tells subscriptions it is not connected when they are created before connect', () => {
            givenStreaming();
            // we test the property because we get the subscription after unavailable has been called, and before we spy on the method
            expect(subscription.connectionAvailable).toEqual(false);
        });

        it('tells subscriptions it is connected when they are created after connect', () => {
            givenStreaming();
            stateChangedCallback({ newState: 1 /* connected */ });
            subscription = streaming.createSubscription(
                'root',
                '/test/test',
                {},
                subscriptionUpdateSpy,
                subscriptionErrorSpy,
            );
            // we test the property because we get the subscription after unavailable has been called, and before we spy on the method
            expect(subscription.connectionAvailable).toEqual(true);
        });

        it('does not cross communicate between two streaming instances', () => {
            givenStreaming();
            givenStreaming();
            startCallback();
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_STARTED,
            );

            expect(stateChangedSpy.mock.calls.length).toEqual(1);
            expect(stateChangedSpy.mock.calls[0]).toEqual([
                streaming.CONNECTION_STATE_STARTED,
            ]);
        });
        it('becomes started when the connection callback returns', () => {
            givenStreaming();
            startCallback();
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_STARTED,
            );

            expect(stateChangedSpy.mock.calls.length).toEqual(1);
            expect(stateChangedSpy.mock.calls[0]).toEqual([
                streaming.CONNECTION_STATE_STARTED,
            ]);
        });
        it('goes to the connecting state', () => {
            givenStreaming();
            stateChangedCallback({ newState: 0 /* connecting */ });
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_CONNECTING,
            );

            expect(stateChangedSpy.mock.calls.length).toEqual(1);
            expect(stateChangedSpy.mock.calls[0]).toEqual([
                streaming.CONNECTION_STATE_CONNECTING,
            ]);

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(0);
        });
        it('goes to the connected state', () => {
            givenStreaming();
            stateChangedCallback({ newState: 1 /* connected */ });
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_CONNECTED,
            );

            expect(stateChangedSpy.mock.calls.length).toEqual(1);
            expect(stateChangedSpy.mock.calls[0]).toEqual([
                streaming.CONNECTION_STATE_CONNECTED,
            ]);

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(1);
            expect(subscription.onConnectionAvailable.mock.calls[0]).toEqual(
                [],
            );
        });
        it('stays connected if started is called after connected state change', () => {
            // this does happen - timing can go either way in the wild
            givenStreaming();
            stateChangedCallback({ newState: 1 /* connected */ });
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_CONNECTED,
            );
            startCallback();
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_CONNECTED,
            );
        });
        it('goes to the reconnected state', () => {
            givenStreaming();
            stateChangedCallback({ newState: 2 /* reconnecting */ });
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_RECONNECTING,
            );

            expect(stateChangedSpy.mock.calls.length).toEqual(1);
            expect(stateChangedSpy.mock.calls[0]).toEqual([
                streaming.CONNECTION_STATE_RECONNECTING,
            ]);

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(0);
        });
        it('goes to the disconnected state', () => {
            givenStreaming();
            stateChangedCallback({ newState: 4 /* disconnected */ });
            expect(streaming.connectionState).toEqual(
                streaming.CONNECTION_STATE_DISCONNECTED,
            );

            expect(stateChangedSpy.mock.calls.length).toEqual(1);
            expect(stateChangedSpy.mock.calls[0]).toEqual([
                streaming.CONNECTION_STATE_DISCONNECTED,
            ]);

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(0);
        });

        it('if signal-r is reconnecting, it does not reset but it does tell the subscription the connection is available', () => {
            givenStreaming();
            stateChangedCallback({ newState: 1 /* connected */ });
            stateChangedCallback({ newState: 2 /* reconnecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(2);
            expect(subscription.reset.mock.calls.length).toEqual(0);
        });

        it('if signal-r disconnects, it tries to connect and resets subscriptions', () => {
            givenStreaming();
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });
            stateChangedCallback({ newState: 4 /* disconnected */ });

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(1);
            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);
            expect(subscription.reset.mock.calls.length).toEqual(0);

            tick(1000); // default connection retry delay

            expect(mockConnection.start.mock.calls.length).toEqual(2);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(2);
            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);
            expect(subscription.reset.mock.calls.length).toEqual(1);
            expect(subscription.reset.mock.calls[0]).toEqual([]);
        });

        it('if signal-r disconnects, it tries to connect and resets subscriptions, if the retry delay is 0', () => {
            givenStreaming({ connectRetryDelay: 0 });
            tick(1); // make sure the context id is different (in reality we will never be disconnected 0ms after starting to connect)

            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });
            stateChangedCallback({ newState: 4 /* disconnected */ });

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(1);
            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);
            expect(subscription.reset.mock.calls.length).toEqual(0);
            expect(subscription.streamingContextId).toEqual('0000000000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );

            tick(0);

            expect(mockConnection.start.mock.calls.length).toEqual(2);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(2);
            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);
            expect(subscription.reset.mock.calls.length).toEqual(1);
            expect(subscription.reset.mock.calls[0]).toEqual([]);

            expect(subscription.streamingContextId).toEqual('0000000100');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );
        });

        it('if signal-r disconnects, it tries to connect and resets subscriptions, if the retry delay is 600,000', () => {
            givenStreaming({ connectRetryDelay: 600000 });
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });
            stateChangedCallback({ newState: 4 /* disconnected */ });

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(1);
            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);
            expect(subscription.reset.mock.calls.length).toEqual(0);
            expect(subscription.streamingContextId).toEqual('0000000000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );

            tick(600000);

            expect(mockConnection.start.mock.calls.length).toEqual(2);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(
                subscription.onConnectionAvailable.mock.calls.length,
            ).toEqual(2);
            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);
            expect(subscription.reset.mock.calls.length).toEqual(1);
            expect(subscription.reset.mock.calls[0]).toEqual([]);

            expect(subscription.streamingContextId).toEqual('0060000000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );
        });

        it('if signal-r disconnects, when retry levels are provided but missing for specific retry, use connectRetryDelay', () => {
            const mockRetryLevels = [{ level: 1, delay: 2500 }];
            const connectRetryDelay = 9000;

            givenStreaming({
                connectRetryDelayLevels: mockRetryLevels,
                connectRetryDelay,
            });
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            // First disconnect
            stateChangedCallback({ newState: 4 /* disconnected */ });

            expect(subscription.streamingContextId).toEqual('0000000000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );

            tick(9000);

            expect(mockConnection.start.mock.calls.length).toEqual(2);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(subscription.streamingContextId).toEqual('0000900000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );
        });

        it('if signal-r disconnects, when retry levels are provided but empty, use connectRetryDelay', () => {
            const mockRetryLevels = [];
            const connectRetryDelay = 7500;

            givenStreaming({
                connectRetryDelayLevels: mockRetryLevels,
                connectRetryDelay,
            });
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            // First disconnect
            stateChangedCallback({ newState: 4 /* disconnected */ });

            expect(subscription.streamingContextId).toEqual('0000000000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );

            tick(7500);

            expect(mockConnection.start.mock.calls.length).toEqual(2);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(subscription.streamingContextId).toEqual('0000750000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );
        });

        it('if signal-r disconnects, it tries to reconnect using defined retry levels', () => {
            const mockRetryLevels = [
                { level: 0, delay: 2500 },
                { level: 1, delay: 5000 },
                { level: 2, delay: 7000 },
            ];

            givenStreaming({ connectRetryDelayLevels: mockRetryLevels });
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            // First disconnect
            stateChangedCallback({ newState: 4 /* disconnected */ });

            expect(subscription.streamingContextId).toEqual('0000000000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );

            tick(2500);

            expect(mockConnection.start.mock.calls.length).toEqual(2);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(subscription.streamingContextId).toEqual('0000250000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );

            // Second disconnect

            stateChangedCallback({ newState: 4 /* disconnected */ });

            tick(5000);

            expect(mockConnection.start.mock.calls.length).toEqual(3);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(subscription.streamingContextId).toEqual('0000750000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );

            // Third disconnect

            stateChangedCallback({ newState: 4 /* disconnected */ });

            tick(7000);

            expect(mockConnection.start.mock.calls.length).toEqual(4);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(subscription.streamingContextId).toEqual('0001450000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );

            // Forth disconnect

            stateChangedCallback({ newState: 4 /* disconnected */ });

            tick(7000);

            expect(mockConnection.start.mock.calls.length).toEqual(5);
            stateChangedCallback({ newState: 0 /* connecting */ });
            stateChangedCallback({ newState: 1 /* connected */ });

            expect(subscription.streamingContextId).toEqual('0002150000');
            expect(subscription.streamingContextId).toEqual(
                streaming.contextId,
            );
        });
    });

    describe('data received', () => {
        it('splits the data and emits each result', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);

            const subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);
            const subscription2 = mockSubscription();
            subscription2.referenceId = 'MySpy2';
            streaming.subscriptions.push(subscription2);

            const data1 = { ReferenceId: 'MySpy', Data: 'one' };
            const data2 = { ReferenceId: 'MySpy2', Data: 'two' };
            receivedCallback([data1, data2]);

            expect(subscription.onStreamingData.mock.calls.length).toEqual(1);
            expect(subscription.onStreamingData.mock.calls[0]).toEqual([data1]);

            expect(subscription2.onStreamingData.mock.calls.length).toEqual(1);
            expect(subscription2.onStreamingData.mock.calls[0]).toEqual([
                data2,
            ]);
        });
        it('handles a null received event', () => {
            expect(() => {
                new Streaming(transport, 'testUrl', authProvider);

                receivedCallback(null);
            }).not.toThrow();
        });
        it('handles data for a subscription not present', () => {
            expect(() => {
                new Streaming(transport, 'testUrl', authProvider);

                const data1 = { ReferenceId: 'MySpy', Data: 'one' };
                receivedCallback([data1]);
            }).not.toThrow();
        });
        it('handles a update without a reference id', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);

            const subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);

            const data1 = {}; // using this to throw an exception, but could be anything
            const data2 = { ReferenceId: 'MySpy', Data: 'one' };
            receivedCallback([data1, data2]);

            expect(subscription.onStreamingData.mock.calls.length).toEqual(1);
            expect(subscription.onStreamingData.mock.calls[0]).toEqual([data2]);
        });
    });

    describe('signal-r events', () => {
        let streaming;
        beforeEach(() => {
            streaming = new Streaming(transport, 'testUrl', authProvider);
        });

        it('handles connection slow events', () => {
            const connectionSlowSpy = jest.fn().mockName('spyOnConnectionSlow');
            streaming.on(streaming.EVENT_CONNECTION_SLOW, connectionSlowSpy);
            connectionSlowCallback();
            expect(connectionSlowSpy.mock.calls.length).toEqual(1);
        });
        it('handles connection error events', () => {
            jest.spyOn(log, 'warn');
            errorCallback('error details');

            expect(log.warn.mock.calls.length).toEqual(1);
        });
        it('handles signal-r log calls', () => {
            jest.spyOn(log, 'debug');
            mockConnection.log('my message');
            expect(log.debug.mock.calls.length).toEqual(1);
        });
    });

    describe('control messages', () => {
        let streaming;
        let subscription;
        beforeEach(() => {
            streaming = new Streaming(transport, 'testUrl', authProvider);
            stateChangedCallback({ newState: 1 /* connected */ });
            subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);
        });

        it('handles heartbeats', () => {
            expect(subscription.onHeartbeat.mock.calls.length).toEqual(0);
            receivedCallback([
                {
                    ReferenceId: '_heartbeat',
                    Heartbeats: [{ OriginatingReferenceId: 'MySpy' }],
                },
            ]);
            expect(subscription.onHeartbeat.mock.calls.length).toEqual(1);
            expect(subscription.onHeartbeat.mock.calls[0]).toEqual([]);
            expect(subscription.reset.mock.calls.length).toEqual(0);
        });
        it('handles and ignores heartbeats for a subscription not present', () => {
            expect(subscription.onHeartbeat.mock.calls.length).toEqual(0);
            receivedCallback([
                {
                    ReferenceId: '_heartbeat',
                    Heartbeats: [{ OriginatingReferenceId: 'foo' }],
                },
            ]);
            expect(subscription.onHeartbeat.mock.calls.length).toEqual(0);
            expect(subscription.reset.mock.calls.length).toEqual(0);
        });
        it('handles reset', () => {
            receivedCallback([
                {
                    ReferenceId: '_resetsubscriptions',
                    TargetReferenceIds: ['MySpy'],
                },
            ]);
            expect(subscription.reset.mock.calls.length).toEqual(1);
            expect(subscription.reset.mock.calls[0]).toEqual([]);
        });
        it('handles and ignores reset for a subscription not present', () => {
            receivedCallback([
                {
                    ReferenceId: '_resetsubscriptions',
                    TargetReferenceIds: ['foo'],
                },
            ]);
            expect(subscription.reset.mock.calls.length).toEqual(0);
        });
        it('handles reset all', () => {
            receivedCallback([{ ReferenceId: '_resetsubscriptions' }]);
            expect(subscription.reset.mock.calls.length).toEqual(1);
            expect(subscription.reset.mock.calls[0]).toEqual([]);
        });
        it('handles reset all for empty TargetReferenceIds array', () => {
            receivedCallback([
                { ReferenceId: '_resetsubscriptions', TargetReferenceIds: [] },
            ]);
            expect(subscription.reset.mock.calls.length).toEqual(1);
            expect(subscription.reset.mock.calls[0]).toEqual([]);
        });
        it('handles an unknown control event', () => {
            receivedCallback([
                { ReferenceId: '_foo', TargetReferenceIds: ['MySpy'] },
            ]);
            expect(subscription.reset.mock.calls.length).toEqual(0);
        });
        it('handles disconnect control message', () => {
            const disconnectRequestedSpy = jest
                .fn()
                .mockName('spyOnDisconnectRequested');

            streaming.on(
                streaming.EVENT_DISCONNECT_REQUESTED,
                disconnectRequestedSpy,
            );
            receivedCallback([{ ReferenceId: '_disconnect' }]);

            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);
            expect(disconnectRequestedSpy).toHaveBeenCalledTimes(1);
        });
        it('handles reconnect control message', (done) => {
            let startPromiseResolver;
            const startPromise = new Promise((resolve) => {
                startPromiseResolver = resolve;
            });

            mockConnection.start.mockImplementation(() => {
                if (stateChangedCallback) {
                    setTimeout(() => {
                        stateChangedCallback({
                            newState: legacySignalrConnectionState.connected,
                        });
                        startPromiseResolver();
                    });
                }
            });

            mockConnection.stop.mockImplementation(() => {
                if (stateChangedCallback) {
                    stateChangedCallback({
                        newState: legacySignalrConnectionState.disconnected,
                    });
                }
            });

            receivedCallback([{ ReferenceId: '_reconnect' }]);

            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);

            startPromise.then(() => {
                expect(subscription.reset.mock.calls.length).toEqual(1);
                done();
            });
        });
    });

    describe('dispose', () => {
        it('unsubscribes everything', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);
            stateChangedCallback({ newState: 1 /* connected */ });

            const subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);
            expect(mockConnection.start.mock.calls.length).toEqual(1);
            mockConnection.start.mockClear();

            jest.spyOn(streaming.orphanFinder, 'stop');

            streaming.dispose();

            expect(
                subscription.onConnectionUnavailable.mock.calls.length,
            ).toEqual(1);
            expect(subscription.reset.mock.calls.length).toEqual(1);
            expect(transport.delete.mock.calls.length).toEqual(1);
            expect(transport.delete.mock.calls[0][0]).toEqual('root');
            expect(transport.delete.mock.calls[0][1]).toEqual(
                'v1/subscriptions/{contextId}',
            );
            expect(transport.delete.mock.calls[0][2]).toEqual({
                contextId: '0000000000',
            });
            expect(streaming.orphanFinder.stop.mock.calls.length).toEqual(1);

            stateChangedCallback({ newState: 4 /* disconnected */ });

            tick(10000);
            expect(mockConnection.start.mock.calls.length).toEqual(0);
        });

        it('disposes an individual subscription', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);
            stateChangedCallback({ newState: 1 /* connected */ });

            const subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);
            const subscription2 = mockSubscription();
            subscription2.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription2);

            streaming.disposeSubscription(subscription);

            expect(subscription.onUnsubscribe.mock.calls.length).toEqual(1);
            expect(subscription.dispose.mock.calls.length).toEqual(1);
            expect(streaming.subscriptions.length).toEqual(1);

            streaming.disposeSubscription(subscription2);

            expect(subscription2.onUnsubscribe.mock.calls.length).toEqual(1);
            expect(subscription2.dispose.mock.calls.length).toEqual(1);
            expect(streaming.subscriptions.length).toEqual(0);

            // copes with being called twice

            streaming.disposeSubscription(subscription2);

            expect(subscription2.onUnsubscribe.mock.calls.length).toEqual(2);
            expect(subscription2.dispose.mock.calls.length).toEqual(2);
            expect(streaming.subscriptions.length).toEqual(0);
        });
    });

    describe('subscription handling', () => {
        it('when a subscription is orphaned, the subscription is reset', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);
            stateChangedCallback({ newState: 1 /* connected */ });

            const subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);
            expect(subscription.reset.mock.calls.length).toEqual(0);

            streaming.orphanFinder.onOrphanFound(subscription);

            expect(subscription.reset.mock.calls.length).toEqual(1);
        });

        it('passes on subscribe calls', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);
            stateChangedCallback({ newState: 1 /* connected */ });

            const subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);
            expect(subscription.onSubscribe.mock.calls.length).toEqual(0);

            streaming.subscribe(subscription);

            expect(subscription.onSubscribe.mock.calls.length).toEqual(1);
        });

        it('updates the orphan finder when a subscription is created', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);
            const subscription = streaming.createSubscription(
                'root',
                '/test/test',
                {},
                subscriptionUpdateSpy,
                subscriptionErrorSpy,
            );

            jest.spyOn(streaming.orphanFinder, 'update');
            subscription.onSubscriptionCreated();

            expect(streaming.orphanFinder.update.mock.calls.length).toEqual(1);
        });

        it('passes on unsubscribe calls', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);
            stateChangedCallback({ newState: 1 /* connected */ });

            const subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);
            expect(subscription.onUnsubscribe.mock.calls.length).toEqual(0);

            streaming.unsubscribe(subscription);

            expect(subscription.onUnsubscribe.mock.calls.length).toEqual(1);
        });

        it('passes options on modify', () => {
            const streaming = new Streaming(transport, 'testUrl', authProvider);
            stateChangedCallback({ newState: 1 /* connected */ });

            const subscription = mockSubscription();
            subscription.referenceId = 'MySpy';
            streaming.subscriptions.push(subscription);

            const args = 'SubscriptionArgs';
            const options = { test: 'test options' };
            streaming.modify(subscription, args, options);

            expect(subscription.onModify.mock.calls.length).toEqual(1);
            expect(subscription.onModify.mock.calls[0][0]).toEqual(args);
            expect(subscription.onModify.mock.calls[0][1]).toEqual(options);
        });
    });

    describe('options', () => {
        it('has defaults', () => {
            new Streaming(transport, 'testUrl', authProvider);
            expect(mockConnection.start.mock.calls.length).toEqual(1);
            expect(mockConnection.start.mock.calls[0][0]).toEqual({
                waitForPageLoad: false,
                transport: ['webSockets', 'longPolling'],
            });
        });

        it('can override waitForPageLoad', () => {
            new Streaming(transport, 'testUrl', authProvider, {
                waitForPageLoad: true,
            });
            expect(mockConnection.start.mock.calls.length).toEqual(1);
            expect(mockConnection.start.mock.calls[0][0]).toEqual({
                waitForPageLoad: true,
                transport: ['webSockets', 'longPolling'],
            });
        });

        it('can override transport', () => {
            new Streaming(transport, 'testUrl', authProvider, {
                transportTypes: ['webSockets'],
            });
            expect(mockConnection.start.mock.calls.length).toEqual(1);
            expect(mockConnection.start.mock.calls[0][0]).toEqual({
                waitForPageLoad: false,
                transport: ['webSockets'],
            });
        });
    });

    describe('unsubscribeByTag', () => {
        let streaming;

        beforeEach(() => {
            streaming = new Streaming(transport, 'testUrl', authProvider);
        });

        it('calls onUnsubscribeByTagPending on subscriptions matching endpoint and tag', (done) => {
            streaming.subscriptions.push({
                onUnsubscribeByTagPending: jest
                    .fn()
                    .mockName('onUnsubscribeByTagPending'),
                url: 'url',
                servicePath: 'servicePath',
                subscriptionData: {
                    Tag: 'tag',
                },
                addStateChangedCallback: () => {},
            });

            streaming.unsubscribeByTag('servicePath', 'url', 'tag');

            setTimeout(() => {
                expect(
                    streaming.subscriptions[0].onUnsubscribeByTagPending,
                ).toHaveBeenCalled();
                done();
            });
        });

        it('does not call onSubscribeByTagPending on subscriptions not matching endpoint and tag', (done) => {
            streaming.subscriptions.push({
                onUnsubscribeByTagPending: jest
                    .fn()
                    .mockName('onUnsubscribeByTagPending'),
                url: 'url',
                servicePath: 'servicePath',
                subscriptionData: {
                    Tag: 'tag',
                },
                addStateChangedCallback: () => {},
            });

            streaming.unsubscribeByTag('servicePath', 'url', 'tag2');
            setTimeout(() => {
                expect(
                    streaming.subscriptions[0].onUnsubscribeByTagPending,
                ).not.toHaveBeenCalled();
                done();
            });
        });

        it('does not call to unsubscribe immediately', (done) => {
            streaming.subscriptions.push({
                onUnsubscribeByTagPending: jest
                    .fn()
                    .mockName('onUnsubscribeByTagPending'),
                url: 'url',
                servicePath: 'servicePath',
                subscriptionData: {
                    Tag: 'tag',
                },
                addStateChangedCallback: () => {},
            });

            streaming.unsubscribeByTag('servicePath', 'url', 'tag');

            setTimeout(() => {
                expect(transport.delete).not.toHaveBeenCalled();
                done();
            });
        });

        it('does not call to unsubscribe when all subscriptions are not ready', (done) => {
            let subscriptionStateChangedCallback;

            streaming.subscriptions.push(
                {
                    onUnsubscribeByTagPending: jest
                        .fn()
                        .mockName('onUnsubscribeByTagPending'),
                    url: 'url',
                    servicePath: 'servicePath',
                    subscriptionData: {
                        Tag: 'tag',
                    },
                    addStateChangedCallback: (callback) => {
                        subscriptionStateChangedCallback = callback;
                    },
                    isReadyForUnsubscribeByTag: () => true,
                },
                {
                    onUnsubscribeByTagPending: jest
                        .fn()
                        .mockName('onUnsubscribeByTagPending'),
                    url: 'url',
                    servicePath: 'servicePath',
                    subscriptionData: {
                        Tag: 'tag',
                    },
                    addStateChangedCallback: () => {},
                    isReadyForUnsubscribeByTag: () => false,
                },
            );

            streaming.unsubscribeByTag('servicePath', 'url', 'tag');
            subscriptionStateChangedCallback();

            setTimeout(() => {
                expect(transport.delete).not.toHaveBeenCalled();
                done();
            });
        });

        it('calls to unsubscribe when all subscriptions are ready', (done) => {
            let subscriptionStateChangedCallback;

            streaming.subscriptions.push(
                {
                    onUnsubscribeByTagPending: jest
                        .fn()
                        .mockName('onUnsubscribeByTagPending'),
                    url: 'url',
                    servicePath: 'servicePath',
                    subscriptionData: {
                        Tag: 'tag',
                    },
                    addStateChangedCallback: (callback) => {
                        subscriptionStateChangedCallback = callback;
                    },
                    removeStateChangedCallback: () => {},
                    isReadyForUnsubscribeByTag: () => true,
                    onUnsubscribeByTagComplete: jest
                        .fn()
                        .mockName('onUnsubscribeByTagComplete'),
                },
                {
                    onUnsubscribeByTagPending: jest
                        .fn()
                        .mockName('onUnsubscribeByTagPending'),
                    url: 'url',
                    servicePath: 'servicePath',
                    subscriptionData: {
                        Tag: 'tag',
                    },
                    addStateChangedCallback: () => {},
                    removeStateChangedCallback: () => {},
                    isReadyForUnsubscribeByTag: () => true,
                    onUnsubscribeByTagComplete: jest
                        .fn()
                        .mockName('onUnsubscribeByTagComplete'),
                },
            );

            streaming.unsubscribeByTag('servicePath', 'url', 'tag');
            subscriptionStateChangedCallback();

            setTimeout(() => {
                expect(transport.delete).toHaveBeenCalled();
                expect(
                    streaming.subscriptions[0].onUnsubscribeByTagComplete,
                ).not.toHaveBeenCalled();
                done();
            });
        });

        it('calls onUnsubscribeByTagComplete when unsubscribe is complete', (done) => {
            let subscriptionStateChangedCallback;

            streaming.subscriptions.push({
                onUnsubscribeByTagPending: jest
                    .fn()
                    .mockName('onUnsubscribeByTagPending'),
                url: 'url',
                servicePath: 'servicePath',
                subscriptionData: {
                    Tag: 'tag',
                },
                addStateChangedCallback: (callback) => {
                    subscriptionStateChangedCallback = callback;
                },
                removeStateChangedCallback: jest
                    .fn()
                    .mockName('removeStateChangedCallback'),
                isReadyForUnsubscribeByTag: () => true,
                onUnsubscribeByTagComplete: jest
                    .fn()
                    .mockName('onUnsubscribeByTagComplete'),
            });

            streaming.unsubscribeByTag('servicePath', 'url', 'tag');
            subscriptionStateChangedCallback();

            setTimeout(() => {
                expect(transport.delete).toHaveBeenCalled();
                transport.deleteResolve();
                setTimeout(() => {
                    expect(
                        streaming.subscriptions[0].onUnsubscribeByTagComplete,
                    ).toHaveBeenCalled();
                    done();
                });
            });
        });

        it('removes state change handler when unsubscribe is complete', (done) => {
            let subscriptionStateChangedCallback;

            streaming.subscriptions.push({
                onUnsubscribeByTagPending: jest
                    .fn()
                    .mockName('onUnsubscribeByTagPending'),
                url: 'url',
                servicePath: 'servicePath',
                subscriptionData: {
                    Tag: 'tag',
                },
                addStateChangedCallback: (callback) => {
                    subscriptionStateChangedCallback = callback;
                },
                removeStateChangedCallback: jest
                    .fn()
                    .mockName('removeStateChangedCallback'),
                isReadyForUnsubscribeByTag: () => true,
                onUnsubscribeByTagComplete: jest
                    .fn()
                    .mockName('onUnsubscribeByTagComplete'),
            });

            streaming.unsubscribeByTag('servicePath', 'url', 'tag');
            subscriptionStateChangedCallback();

            setTimeout(() => {
                expect(transport.delete).toHaveBeenCalled();
                transport.deleteResolve();
                setTimeout(() => {
                    expect(
                        streaming.subscriptions[0].removeStateChangedCallback,
                    ).toHaveBeenCalled();
                    done();
                });
            });
        });
    });

    describe('resetStreaming', () => {
        let spySocketClose;
        let mockHubConnection;
        let resolveSignalrCoreStartPromise;
        let signalrCoreStartPromise;
        let resolvePlainWebsocketStartPromise;
        let plainWebsocketStartPromise;
        let mockSignalMessageReceivedHandler;
        let mockStreamCancel;
        let mockCloseConnection;
        let streaming;

        class MockConnectionBuilder {
            withUrl() {
                return this;
            }
            withHubProtocol() {
                return this;
            }
            configureLogging() {
                return this;
            }
            withAutomaticReconnect() {
                return this;
            }
            build() {
                return mockHubConnection;
            }
        }

        function JsonHubProtocol() {}

        beforeEach(() => {
            spySocketClose = jest.fn().mockName('spySocketClose');

            plainWebsocketStartPromise = new Promise((resolve) => {
                resolvePlainWebsocketStartPromise = resolve;
            });

            global.WebSocket = jest.fn().mockImplementation(() => {
                streaming.connection.transport.stateChangedCallback(
                    connectionConstants.CONNECTION_STATE_CONNECTED,
                );

                resolvePlainWebsocketStartPromise();

                return {
                    close: spySocketClose,
                };
            });

            global.signalrCore = {
                HubConnectionBuilder: MockConnectionBuilder,
                JsonHubProtocol,
                HttpTransportType: {
                    WebSockets: 1,
                    LongPolling: 4,
                },
            };

            const mockSubject = {
                subscribe: ({ next }) => {
                    mockSignalMessageReceivedHandler = next;
                },
                cancelCallback: () => {
                    mockStreamCancel = getResolvablePromise();
                    return mockStreamCancel.promise;
                },
            };

            const closeCallbacks = [];
            mockHubConnection = {
                start: jest
                    .fn()
                    .mockName('signalrConnectionStart')
                    .mockImplementation(() => {
                        signalrCoreStartPromise = new Promise(
                            (resolve) =>
                                (resolveSignalrCoreStartPromise = () => {
                                    streaming.connection.transport.stateChangedCallback(
                                        connectionConstants.CONNECTION_STATE_CONNECTED,
                                    );
                                    resolve();
                                }),
                        );
                        return signalrCoreStartPromise;
                    }),
                stream: jest
                    .fn()
                    .mockName('message stream')
                    .mockImplementation(() => mockSubject),
                stop: jest.fn().mockImplementation(() => {
                    closeCallbacks.forEach((callback) => {
                        callback();
                    });
                }),
                invoke: (method, ...args) => {
                    if (method === 'CloseConnection') {
                        mockCloseConnection = getResolvablePromise();
                        return mockCloseConnection.promise;
                    }

                    return Promise.resolve();
                },
                onclose: jest.fn().mockImplementation((callback) => {
                    closeCallbacks.push(callback);
                }),
                onreconnecting: jest.fn(),
                onreconnected: jest.fn(),
            };
        });

        it('should reset streaming with new url and options', (done) => {
            streaming = new Streaming(transport, 'testUrl', authProvider, {
                transportTypes: [streamingTransports.PLAIN_WEBSOCKETS],
            });

            const subscription = mockSubscription();
            subscription.referenceId = 'testSubscription';
            streaming.subscriptions.push(subscription);

            fetchMock.resolve(200);

            plainWebsocketStartPromise.then(() => {
                expect(subscription.onUnsubscribe).not.toHaveBeenCalled();

                streaming.resetStreaming('newStreamingUrl', {
                    transportTypes: [
                        streamingTransports.SIGNALR_CORE_WEBSOCKETS,
                    ],
                });

                expect(spySocketClose).toHaveBeenCalledTimes(1);
                expect(streaming.retryCount).toBe(0);
                expect(
                    subscription.onConnectionUnavailable,
                ).toHaveBeenCalledTimes(1);
                expect(mockHubConnection.start).toHaveBeenCalledTimes(1);

                done();
            });
        });

        it('should reset streaming when there is no active transport', (done) => {
            streaming = new Streaming(transport, 'testUrl', authProvider, {
                transportTypes: [],
            });

            const subscription = mockSubscription();
            subscription.referenceId = 'testSubscription';
            streaming.subscriptions.push(subscription);

            streaming.resetStreaming('newStreamingUrl', {
                transportTypes: [streamingTransports.PLAIN_WEBSOCKETS],
            });

            fetchMock.resolve(200);

            plainWebsocketStartPromise.then(() => {
                expect(subscription.reset).toHaveBeenCalled();

                done();
            });
        });

        it('should fallback to on-premise streaming service if cloud streaming fails', (done) => {
            streaming = new Streaming(transport, 'testUrl', authProvider, {
                transportTypes: [streamingTransports.SIGNALR_CORE_WEBSOCKETS],
            });

            const subscription = mockSubscription();
            subscription.referenceId = 'testSubscription';
            streaming.subscriptions.push(subscription);

            let resolveResetStreamingPromise;
            const resetStreamingPromise = new Promise((resolve) => {
                resolveResetStreamingPromise = resolve;
            });

            // mock fallback implementation
            streaming.on(streaming.EVENT_STREAMING_FAILED, () => {
                streaming.resetStreaming('newStreamingUrl', {
                    transportTypes: [streamingTransports.PLAIN_WEBSOCKETS],
                });

                resolveResetStreamingPromise();
            });

            resolveSignalrCoreStartPromise();

            signalrCoreStartPromise
                .then(() => {
                    // push invalid message which should trigger disconnection and fallback
                    mockSignalMessageReceivedHandler({
                        Payload: '{ testKey: testValue',
                        PayloadFormat: 1,
                    });

                    // resolve connection close
                    mockStreamCancel.resolve();
                    return mockStreamCancel.promise;
                })
                .then(() => {
                    mockCloseConnection.resolve();
                    return mockStreamCancel.promise;
                })
                .then(() => {
                    // trigger streaming failed event
                    tick(10);
                });

            resetStreamingPromise
                .then(() => {
                    fetchMock.resolve(200);

                    return plainWebsocketStartPromise;
                })
                .then(() => {
                    expect(subscription.reset).toHaveBeenCalled();

                    done();
                });
        });

        it('should clear reconnection timer while resetting streaming', () => {
            streaming = new Streaming(transport, 'testUrl', authProvider, {
                transportTypes: [streamingTransports.SIGNALR_CORE_WEBSOCKETS],
            });

            const subscription = mockSubscription();
            subscription.referenceId = 'testSubscription';
            streaming.subscriptions.push(subscription);

            // should trigger reconnection
            mockHubConnection.stop();

            expect(streaming.retryCount).toEqual(1);

            streaming.resetStreaming('newStreamingUrl', {
                transportTypes: [streamingTransports.PLAIN_WEBSOCKETS],
            });

            expect(streaming.retryCount).toEqual(0);
        });
    });
});
