/**
 * @module saxo/openapi/streaming/subscription
 * @ignore
 */
import { extend } from '../../utils/object';
import log from '../../log';
import {
    ACTION_SUBSCRIBE,
    ACTION_UNSUBSCRIBE,
    ACTION_MODIFY_PATCH,
    ACTION_UNSUBSCRIBE_BY_TAG_PENDING,
} from './subscription-actions';
import SubscriptionQueue from './subscription-queue';
import ParserFacade from './parser/parser-facade';

// -- Local variables section --

/**
 * The static counter to generate unique reference id's.
 */
let referenceIdCounter = 1;

const DEFAULT_REFRESH_RATE_MS = 1000;
const MIN_REFRESH_RATE_MS = 100;

const FORMAT_PROTOBUF = 'application/x-protobuf';
const FORMAT_JSON = 'application/json';

const ERROR_UNSUPPORTED_FORMAT = 'UnsupportedSubscriptionFormat';

const LOG_AREA = 'Subscription';

// -- Local methods section --

/**
 * Returns url used in subscribe post request.
 * Supports pagination (includes Top property in url request).
 */
function getSubscribeUrl(url, subscriptionData) {
    if (!subscriptionData.Top) {
        return url;
    }

    return url + '?$top=' + subscriptionData.Top;
}

/**
 * Normalize subscription data, by removing
 * unsupported properties.
 */
function normalizeSubscribeData(data) {
    if (data.hasOwnProperty('Top')) {
        delete data.Top;
    }
}

/**
 * Call to actually do a subscribe.
 */
function subscribe() {
    // capture the reference id so we can tell in the response whether it is the latest call
    const referenceId = String(referenceIdCounter++);
    this.referenceId = referenceId;

    // reset any updates before subscribed
    this.updatesBeforeSubscribed = null;

    const subscribeUrl = getSubscribeUrl(this.url, this.subscriptionData);

    const data = extend({}, this.subscriptionData, {
        ContextId: this.streamingContextId,
        ReferenceId: referenceId,
        KnownSchemas: this.parser.getSchemaNames(),
    });
    const options = { body: data };

    if (this.headers) {
        options.headers = extend({}, this.headers);
    }

    normalizeSubscribeData(data);

    log.debug(LOG_AREA, 'Posting to create a subscription', {
        servicePath: this.servicePath,
        url: subscribeUrl,
    });
    setState.call(this, this.STATE_SUBSCRIBE_REQUESTED);

    this.currentStreamingContextId = this.streamingContextId;
    this.transport
        .post(this.servicePath, subscribeUrl, null, options)
        .then(onSubscribeSuccess.bind(this, referenceId))
        .catch(onSubscribeError.bind(this, referenceId));
}

/**
 * Does an actual unsubscribe.
 */
function unsubscribe() {
    setState.call(this, this.STATE_UNSUBSCRIBE_REQUESTED);
    // capture the reference id so we can tell in the response whether it is the latest call
    const referenceId = this.referenceId;

    this.transport
        .delete(this.servicePath, this.url + '/{contextId}/{referenceId}', {
            contextId: this.currentStreamingContextId,
            referenceId,
        })
        .then(onUnsubscribeSuccess.bind(this, referenceId))
        .catch(onUnsubscribeError.bind(this, referenceId));
}
/**
 * Does subscription modification through PATCH request
 */
function modifyPatch(args) {
    setState.call(this, this.STATE_PATCH_REQUESTED);
    const referenceId = this.referenceId;

    this.transport
        .patch(
            this.servicePath,
            this.url + '/{contextId}/{referenceId}',
            {
                contextId: this.currentStreamingContextId,
                referenceId: this.referenceId,
            },
            { body: args },
        )
        .then(onModifyPatchSuccess.bind(this, referenceId))
        .catch(onModifyPatchError.bind(this, referenceId));
}

function unsubscribeByTagPending() {
    setState.call(this, this.STATE_READY_FOR_UNSUBSCRIBE_BY_TAG);
}

/**
 * Queues or performs an action based on the current state.
 * Supports queue for more then one action, to support consecutive modify requests,
 * which invoke unsubscribe and subscribe one after another.
 * @param action
 * @param args
 */
function tryPerformAction(action, args) {
    if (this.networkErrorSubscribingTimer) {
        // Clear the timeout - some other external event has happened which overrides the network timeout
        clearTimeout(this.networkErrorSubscribingTimer);
        this.networkErrorSubscribingTimer = null;
    }

    if (
        !this.connectionAvailable ||
        this.TRANSITIONING_STATES & this.currentState
    ) {
        this.queue.enqueue({ action, args });
    } else {
        performAction.call(this, { action, args });
    }
}

/**
 * Callback for when the subscription is ready to perform the next action.
 */
function onReadyToPerformNextAction() {
    if (!this.connectionAvailable || this.queue.isEmpty()) {
        return;
    }
    performAction.call(this, this.queue.dequeue(), this.queue.isEmpty());
}

/**
 * Performs an action to a subscription based on the current state.
 * @param queuedAction
 * @param isLastQueuedAction
 */
function performAction(queuedAction, isLastQueuedAction) {
    const { action, args } = queuedAction;

    switch (action) {
        case ACTION_SUBSCRIBE:
            switch (this.currentState) {
                case this.STATE_SUBSCRIBED:
                    break;

                case this.STATE_UNSUBSCRIBED:
                    this.queue.clearPatches();
                    subscribe.call(this);
                    break;

                default:
                    log.error(
                        LOG_AREA,
                        'Unanticipated state in performAction Subscribe',
                        {
                            state: this.currentState,
                            action,
                            url: this.url,
                            servicePath: this.servicePath,
                        },
                    );
            }
            break;

        case ACTION_MODIFY_PATCH:
            switch (this.currentState) {
                case this.STATE_SUBSCRIBED:
                    modifyPatch.call(this, args);
                    break;

                default:
                    log.error(
                        LOG_AREA,
                        'Unanticipated state in performAction Patch',
                        {
                            state: this.currentState,
                            action,
                        },
                    );
            }
            break;

        case ACTION_UNSUBSCRIBE:
            switch (this.currentState) {
                case this.STATE_SUBSCRIBED:
                    unsubscribe.call(this);
                    break;

                case this.STATE_UNSUBSCRIBED:
                    break;

                default:
                    log.error(
                        LOG_AREA,
                        'Unanticipated state in performAction Unsubscribe',
                        {
                            state: this.currentState,
                            action,
                        },
                    );
            }
            break;

        case ACTION_UNSUBSCRIBE_BY_TAG_PENDING:
            switch (this.currentState) {
                case this.STATE_SUBSCRIBED:
                case this.STATE_UNSUBSCRIBED:
                    unsubscribeByTagPending.call(this);
                    break;

                default:
                    log.error(
                        LOG_AREA,
                        'Unanticipated state in performAction UnsubscribeByTagPending',
                        {
                            state: this.currentState,
                            action,
                        },
                    );
            }
            break;

        default:
            throw new Error('unrecognised action ' + action);
    }

    if (this.onQueueEmpty && isLastQueuedAction) {
        this.onQueueEmpty();
    }

    // Required to manually rerun next action, because if nothing happens in given cycle,
    // next task from a queue will never be picked up.
    if (
        !this.queue.isEmpty() &&
        !(this.TRANSITIONING_STATES & this.currentState)
    ) {
        performAction.call(this, this.queue.dequeue(), this.queue.isEmpty());
    }
}

/**
 * Handles the response to the initial REST request that creates the subscription.
 * {Object} result
 * {string} result.State The current state (Active/Suspended)
 * {string} result.Format The media type (RFC 2046), of the serialized data updates that are streamed to the client.
 * {string} result.ContextId The streaming context id that this response is associated with.
 * {number=0} result.InactivityTimeout The time (in seconds) that the client should accept the subscription to be inactive
 *          before considering it invalid.
 * {number=0} result.RefreshRate Actual refresh rate assigned to the subscription according to the customers SLA.
 * {Object} result.Snapshot Snapshot of the current data available
 */
function onSubscribeSuccess(referenceId, result) {
    const responseData = result.response;

    if (referenceId !== this.referenceId) {
        log.info(
            LOG_AREA,
            'Received an Ok subscribe response for subscribing a subscription that has afterwards been reset - ignoring',
        );
        // we could send the contextId as well an attempt a unsubscribe, but its hard to guess what could lead to this.
        // - (reset by disconnect/reconnect from streaming) we started subscribing, then web sockets was disconnected, but
        //    the server doesn't know it yet
        //   - in this case the contextId should be changed and the server will drop the old session soon. we won't receive updates
        // - (reset by streaming control message) we started subscribing, then we get a web socket reset event before the rest server
        //    responded
        //   - in this case the contextId should be the same and the server itself has told us the subscription is dead
        // - (reset by heartbeat lapse) - this indicates a bug in the library since this shouldn't happen
        //   - in this case the contextId should be the same and we will probably get messages that cannot be matched to a subscription
        return;
    }

    setState.call(this, this.STATE_SUBSCRIBED);

    this.inactivityTimeout = responseData.InactivityTimeout || 0;

    if (!responseData.InactivityTimeout === 0) {
        // this mostly happens when there is some other problem e.g. the response cannot be parsed
        log.warn(
            LOG_AREA,
            'inactivity timeout is 0 - interpreting as never timeout. Remove warning if normal.',
            result,
        );
    }

    onActivity.call(this);

    if (this.onSubscriptionCreated) {
        this.onSubscriptionCreated();
    }

    // do not fire events if we are waiting to unsubscribe
    if (this.queue.peekAction() !== ACTION_UNSUBSCRIBE) {
        try {
            this.processSnapshot(responseData);
        } catch (error) {
            log.error(
                LOG_AREA,
                'Exception occurred in streaming snapshot update callback',
                error,
            );
        }

        if (this.updatesBeforeSubscribed) {
            for (let i = 0; i < this.updatesBeforeSubscribed.length; i++) {
                this.onStreamingData(this.updatesBeforeSubscribed[i]);
            }
        }
    }
    this.updatesBeforeSubscribed = null;

    onReadyToPerformNextAction.call(this);
}

function cleanUpLeftOverSubscription(referenceId) {
    this.transport
        .delete(this.servicePath, this.url + '/{contextId}/{referenceId}', {
            contextId: this.currentStreamingContextId,
            referenceId,
        })
        .catch((error) => {
            log.debug(
                LOG_AREA,
                'Failed to remove duplicate request subscription',
                error,
            );
        });
}

/**
 * Called when a subscribe errors
 * @param response
 */
function onSubscribeError(referenceId, response) {
    if (referenceId !== this.referenceId) {
        log.debug(
            LOG_AREA,
            'Received an error response for subscribing a subscription that has afterwards been reset - ignoring',
        );
        return;
    }

    const willUnsubscribe = this.queue.peekAction() & ACTION_UNSUBSCRIBE;

    setState.call(this, this.STATE_UNSUBSCRIBED);

    // if we are a duplicate response, we should unsubscribe now
    const isDupeRequest =
        response &&
        response.response &&
        response.response.Message ===
            'Subscription Key (Streaming Session, Reference Id) already in use';

    if (isDupeRequest) {
        log.error(LOG_AREA, `A duplicate request occurred subscribing`, {
            response,
            url: this.url,
            servicePath: this.servicePath,
            ContextId: this.currentStreamingContextId,
            ReferenceId: referenceId,
            subscriptionData: this.subscriptionData,
        });

        cleanUpLeftOverSubscription.call(this, referenceId);

        // if a duplicate request we reset as it should pass 2nd time around
        if (!willUnsubscribe) {
            tryPerformAction.call(this, ACTION_SUBSCRIBE);
            return;
        }
    }

    const errorCode =
        response && response.response ? response.response.ErrorCode : null;

    if (
        errorCode === ERROR_UNSUPPORTED_FORMAT &&
        this.subscriptionData &&
        this.subscriptionData.Format === FORMAT_PROTOBUF
    ) {
        log.warn(LOG_AREA, `Protobuf is not supported, falling back to JSON`, {
            response,
            url: this.url,
            subscriptionData: this.subscriptionData,
        });

        // Fallback to JSON format if specific endpoint doesn't support PROTOBUF format.
        this.subscriptionData.Format = FORMAT_JSON;
        this.parser = ParserFacade.getParser(
            FORMAT_JSON,
            this.servicePath,
            this.url,
        );

        if (!willUnsubscribe) {
            tryPerformAction.call(this, ACTION_SUBSCRIBE);
            return;
        }
    }

    const isNetworkError = response && response.isNetworkError;
    if (isNetworkError && !willUnsubscribe) {
        // its possible we sent the request before we noticed internet is unavailable
        // also possible this is a one off
        // its also possible that the subscribe succeeded - but that is unlikely and hard to handle

        log.debug(
            LOG_AREA,
            `A network error occurred subscribing to ${this.url}`,
            {
                response,
                url: this.url,
                servicePath: this.servicePath,
                ContextId: this.currentStreamingContextId,
                ReferenceId: referenceId,
                subscriptionData: this.subscriptionData,
            },
        );

        // let streaming know we got a network error
        this.networkErrorSubscribingTimer = setTimeout(() => {
            this.networkErrorSubscribingTimer = null;

            // we did not go offline and we did not receive any commands in the meantime
            // otherwise this timeout would be cancelled.
            // so we can assume this was a one off network error and we can try again
            tryPerformAction.call(this, ACTION_SUBSCRIBE);
        }, 5000);

        if (this.onNetworkError) {
            this.onNetworkError();
        }

        return;
    }

    if (!isNetworkError) {
        log.error(LOG_AREA, `An error occurred subscribing to ${this.url}`, {
            response,
            url: this.url,
            servicePath: this.servicePath,
            ContextId: this.currentStreamingContextId,
            ReferenceId: referenceId,
            subscriptionData: this.subscriptionData,
        });
    }

    // if we are unsubscribed, do not fire the error handler
    if (!willUnsubscribe) {
        if (this.onError) {
            this.onError(response);
        }
    }

    onReadyToPerformNextAction.call(this);
}

/**
 * Called after subscribe is successful
 * @param referenceId
 * @param response
 */
function onUnsubscribeSuccess(referenceId, response) {
    if (referenceId !== this.referenceId) {
        log.debug(
            LOG_AREA,
            'Received an error response for subscribing a subscription that has afterwards been reset - ignoring',
        );
        // we were unsubscribing when reset and the unsubscribe succeeded
        // return because we may have been asked to subscribe after resetting
        return;
    }

    setState.call(this, this.STATE_UNSUBSCRIBED);
    onReadyToPerformNextAction.call(this);
}

/**
 * Called when a unsubscribe errors
 * @param response
 */
function onUnsubscribeError(referenceId, response) {
    if (referenceId !== this.referenceId) {
        log.debug(
            LOG_AREA,
            'Received an error response for unsubscribing a subscription that has afterwards been reset - ignoring',
        );
        return;
    }

    setState.call(this, this.STATE_UNSUBSCRIBED);

    // It seems this can happen if the streaming server unsubscribes just before us (e.g. d/c)
    log.info(LOG_AREA, 'An error occurred unsubscribing', {
        response,
        url: this.url,
    });
    onReadyToPerformNextAction.call(this);
}

/**
 * Called after modify patch is successful
 * @param referenceId
 * @param response
 */
function onModifyPatchSuccess(referenceId, response) {
    if (referenceId !== this.referenceId) {
        log.debug(
            LOG_AREA,
            'Received a response for modify patch a subscription that has afterwards been reset - ignoring',
        );
        return;
    }

    setState.call(this, this.STATE_SUBSCRIBED);
    onReadyToPerformNextAction.call(this);
}

/**
 * Called when a unsubscribe errors
 * @param response
 */
function onModifyPatchError(referenceId, response) {
    if (referenceId !== this.referenceId) {
        log.debug(
            LOG_AREA,
            'Received an error response for modify patch a subscription that has afterwards been reset - ignoring',
        );
        return;
    }

    setState.call(this, this.STATE_SUBSCRIBED);
    log.error(LOG_AREA, `An error occurred patching ${this.url}`, {
        response,
        url: this.url,
    });
    onReadyToPerformNextAction.call(this);
}

/**
 * Resets the subscription activity
 */
function onActivity() {
    this.latestActivity = new Date().getTime();
}

function setState(state) {
    this.currentState = state;
    for (let i = 0; i < this.onStateChangedCallbacks.length; i++) {
        this.onStateChangedCallbacks[i](state);
    }
}

// -- Exported methods section --

/**
 * A subscription to a resource, which streams updates.
 *
 * This class should not be constructed directly, it should instead be created via the
 * {@link saxo.openapi.Streaming#createSubscription} factory method.
 *
 * @class
 * @alias saxo.openapi.StreamingSubscription
 */
// eslint-disable-next-line max-params
function Subscription(
    streamingContextId,
    transport,
    servicePath,
    url,
    subscriptionArgs,
    onSubscriptionCreated,
    options = {},
) {
    /**
     * The streaming context id identifies the particular streaming connection that this subscription will use to subscribe.
     * It is updated while reconnecting with new connection or switching between on-premise and cloud streaming
     * @type {string}
     */
    this.streamingContextId = streamingContextId;

    /**
     * This will be set when subscribed and will be used to unsubscribe
     * @type {string}
     */
    this.currentStreamingContextId = null;

    /**
     * The reference id is used to identify this subscription.
     * @type {string}
     */
    this.referenceId = null;

    /**
     * The action queue.
     * @type {SubscriptionQueue}
     */
    this.queue = new SubscriptionQueue();

    /**
     * The parser, chosen based on provided format.
     */
    this.parser = ParserFacade.getParser(
        subscriptionArgs.Format,
        servicePath,
        url,
    );

    this.onStateChangedCallbacks = [];

    this.transport = transport;
    this.servicePath = servicePath;
    this.url = url;
    this.onSubscriptionCreated = onSubscriptionCreated;
    this.subscriptionData = subscriptionArgs;

    /**
     * Setting optional fields.
     */
    this.onUpdate = options.onUpdate;
    this.onError = options.onError;
    this.onQueueEmpty = options.onQueueEmpty;
    this.headers = options.headers && extend({}, options.headers);
    this.onNetworkError = options.onNetworkError;

    if (!this.subscriptionData.RefreshRate) {
        this.subscriptionData.RefreshRate = DEFAULT_REFRESH_RATE_MS;
    } else if (this.subscriptionData.RefreshRate < MIN_REFRESH_RATE_MS) {
        log.warn(
            LOG_AREA,
            'Low refresh rate - this has been rounded up to the minimum',
            { minimumRate: MIN_REFRESH_RATE_MS },
        );
        this.subscriptionData.RefreshRate = MIN_REFRESH_RATE_MS;
    }
    this.connectionAvailable = true;

    setState.call(this, this.STATE_UNSUBSCRIBED);
}

Subscription.prototype.UPDATE_TYPE_SNAPSHOT = 1;
Subscription.prototype.UPDATE_TYPE_DELTA = 2;

Subscription.prototype.STATE_SUBSCRIBE_REQUESTED = 0x1;
Subscription.prototype.STATE_SUBSCRIBED = 0x2;
Subscription.prototype.STATE_UNSUBSCRIBE_REQUESTED = 0x4;
Subscription.prototype.STATE_UNSUBSCRIBED = 0x8;
Subscription.prototype.STATE_PATCH_REQUESTED = 0x10;

Subscription.prototype.TRANSITIONING_STATES =
    Subscription.prototype.STATE_SUBSCRIBE_REQUESTED |
    Subscription.prototype.STATE_UNSUBSCRIBE_REQUESTED |
    Subscription.prototype.STATE_PATCH_REQUESTED |
    Subscription.prototype.STATE_READY_FOR_UNSUBSCRIBE_BY_TAG;

/**
 * Defines the name of the property on data used to indicate that the data item is a deletion, rather than a
 * insertion / update.
 * @type {string}
 */
Subscription.prototype.OPENAPI_DELETE_PROPERTY = '__meta_deleted';

/**
 * Add a callback to be invoked when the subscription state changes.
 */
Subscription.prototype.addStateChangedCallback = function(callback) {
    const index = this.onStateChangedCallbacks.indexOf(callback);

    if (index === -1) {
        this.onStateChangedCallbacks.push(callback);
    }
};

/**
 * Remove a callback which was invoked when the subscription state changes.
 */
Subscription.prototype.removeStateChangedCallback = function(callback) {
    const index = this.onStateChangedCallbacks.indexOf(callback);

    if (index > -1) {
        this.onStateChangedCallbacks.splice(index, 1);
    }
};

Subscription.prototype.processUpdate = function(message, type) {
    let nextMessage;
    try {
        nextMessage = extend({}, message, {
            Data: this.parser.parse(message.Data, this.SchemaName),
        });
    } catch (error) {
        log.error(LOG_AREA, 'Error occurred parsing Data', {
            error,
            servicePath: this.servicePath,
            url: this.url,
        });

        // if we cannot understand an update we should re-subscribe to make sure we are updated
        this.reset();
        return;
    }

    this.onUpdate(nextMessage, type);
};

Subscription.prototype.processSnapshot = function(response) {
    if (response.Schema && response.SchemaName) {
        this.SchemaName = response.SchemaName;
        this.parser.addSchema(response.Schema, response.SchemaName);
    }

    if (!response.SchemaName) {
        // If SchemaName is missing, trying to use last valid schema name from parser as an fallback.
        this.SchemaName = this.parser.getSchemaName();

        if (
            this.subscriptionData.Format === FORMAT_PROTOBUF &&
            !this.SchemaName
        ) {
            // If SchemaName is missing both in response and parser cache, it means that openapi doesn't support protobuf fot this endpoint.
            // In such scenario, falling back to default parser.
            this.parser = ParserFacade.getParser(
                ParserFacade.getDefaultFormat(),
                this.servicePath,
                this.url,
            );
        }
    }

    // Serialization of Snapshot is not yet supported.
    this.onUpdate(response.Snapshot, this.UPDATE_TYPE_SNAPSHOT);
};

/**
 * Reset happens when the server notices that a publisher is dead or when
 * it misses some messages so it doesn't know who is dead (reset all)
 * This may be called with a burst of messages. The intent is that we queue
 * an operation to unsubscribe, wait for that to finish and then subscribe
 * This waiting means that if we get further resets whilst unsubscribing, we
 * can ignore them. It also ensures that we don't hit the subscription limit
 * because the subscribe manages to get to the server before the unsubscribe.
 * @private
 */
Subscription.prototype.reset = function() {
    switch (this.currentState) {
        case this.STATE_UNSUBSCRIBED:
        case this.STATE_UNSUBSCRIBE_REQUESTED:
            // do not do anything - even if the next action is to subscribe, we can go ahead and do that when the unsubscribe response comes back
            return;

        case this.STATE_SUBSCRIBE_REQUESTED:
        case this.STATE_SUBSCRIBED:
            // we could have been in the process of subscribing when we got a reset. We can only assume that the new thing we are subscribing to
            // was also reset. or we are subscribed / patch requested.. either way we now need to unsubscribe.
            // if it was in process of subscribing it will now unusbscribe once the subscribe returns.

            // If we are going to unsubscribe next already, we can ignore this reset
            if (this.queue.peekAction() & ACTION_UNSUBSCRIBE) {
                return;
            }
            this.onUnsubscribe(true);
            break;

        case this.STATE_PATCH_REQUESTED:
            // we can ignore the patch we are doing and just go ahead and unsubscribe
            setState.call(this, this.STATE_SUBSCRIBED);
            this.onUnsubscribe(true);
            break;

        case this.STATE_READY_FOR_UNSUBSCRIBE_BY_TAG:
            // We are about to unsubscribe by tag, so no need to do anything
            return;

        default:
            log.error(
                LOG_AREA,
                'Reset was called but subscription is in an unknown state',
            );
            return;
    }

    // subscribe... this will go ahead unless the connection is unavailable, after unsubscribe has occurred
    this.onSubscribe();
};

/**
 * Try to subscribe.
 * @param {Boolean} modify - The modify flag indicates that subscription action is part of subscription modification.
 *                           If true, any unsubscribe before subscribe will be kept. Otherwise they are dropped.
 * @private
 */
Subscription.prototype.onSubscribe = function() {
    if (this.isDisposed) {
        throw new Error(
            'Subscribing a disposed subscription - you will not get data',
        );
    }

    tryPerformAction.call(this, ACTION_SUBSCRIBE);
};

/**
 * Try to modify.
 * @param {Object} newArgs - Updated arguments of modified subscription.
 * @private
 */
Subscription.prototype.onModify = function(newArgs, options) {
    if (this.isDisposed) {
        throw new Error(
            'Modifying a disposed subscription - you will not get data',
        );
    }

    this.subscriptionData.Arguments = newArgs;
    if (options && options.isPatch) {
        if (!options.patchArgsDelta) {
            throw new Error('Modify options patchArgsDelta is not defined');
        }
        tryPerformAction.call(
            this,
            ACTION_MODIFY_PATCH,
            options.patchArgsDelta,
        );
    } else {
        // resubscribe with new arguments
        this.onUnsubscribe(true);
        this.onSubscribe();
    }
};

/**
 * Try to unsubscribe.
 * @private
 */
Subscription.prototype.onUnsubscribe = function(forceUnsubscribe) {
    if (this.isDisposed) {
        log.warn(
            LOG_AREA,
            'Unsubscribing a disposed subscription - this is not necessary',
        );
    }

    tryPerformAction.call(this, ACTION_UNSUBSCRIBE, {
        force: Boolean(forceUnsubscribe),
    });
};

/**
 * Tells us we are now disposed
 * @private
 */
Subscription.prototype.dispose = function() {
    this.isDisposed = true;
};

/**
 * Tell the subscription that the connection is unavailable.
 * @private
 */
Subscription.prototype.onConnectionUnavailable = function() {
    this.connectionAvailable = false;
    if (this.networkErrorSubscribingTimer) {
        // we recently received a network error, so now we can just wait until we are online again
        clearTimeout(this.networkErrorSubscribingTimer);
        this.networkErrorSubscribingTimer = null;
        tryPerformAction.call(this, ACTION_SUBSCRIBE);
    }
};

/**
 * Tell the subscription that the connection is available and it can perform any queued action.
 * @private
 */
Subscription.prototype.onConnectionAvailable = function() {
    this.connectionAvailable = true;

    // if we waited to do something and we are not transitioning, then try something
    if (!(this.TRANSITIONING_STATES & this.currentState)) {
        onReadyToPerformNextAction.call(this);
    }
};

/**
 * Handles the 'data' event raised by Streaming.
 * @private
 * @returns {boolean} false if the update is not for this subscription
 */
Subscription.prototype.onStreamingData = function(message) {
    onActivity.call(this);

    switch (this.currentState) {
        // if we are unsubscribed or trying to unsubscribe then ignore the data
        case this.STATE_UNSUBSCRIBE_REQUESTED:
            return;

        case this.STATE_UNSUBSCRIBED:
            return false;

        // we received a delta before we got initial data
        case this.STATE_SUBSCRIBE_REQUESTED:
            this.updatesBeforeSubscribed = this.updatesBeforeSubscribed || [];
            this.updatesBeforeSubscribed.push(message);
            return;

        // the normal state, go ahead
        case this.STATE_SUBSCRIBED:
        case this.STATE_PATCH_REQUESTED:
            break;

        default:
            log.error(LOG_AREA, 'Unanticipated state onStreamingData', {
                currentState: this.currentState,
                url: this.url,
                servicePath: this.servicePath,
            });
    }

    try {
        this.processUpdate(message, this.UPDATE_TYPE_DELTA);
    } catch (error) {
        log.error(
            LOG_AREA,
            'Exception occurred in streaming delta update callback',
            {
                error: {
                    message: error.message,
                    stack: error.stack,
                },
                payload: message,
                url: this.url,
                servicePath: this.servicePath,
            },
        );
    }
};

/**
 * Handles a heartbeat from the server.
 * @private
 */
Subscription.prototype.onHeartbeat = function() {
    if (this.currentState === this.STATE_SUBSCRIBE_REQUESTED) {
        log.debug(
            LOG_AREA,
            'Received heartbeat for a subscription we havent subscribed to yet',
            { url: this.url, servicePath: this.servicePath },
        );
    }
    onActivity.call(this);
};

/**
 * Handle a subscription pending unsubscribe by tag.
 */
Subscription.prototype.onUnsubscribeByTagPending = function() {
    tryPerformAction.call(this, ACTION_UNSUBSCRIBE_BY_TAG_PENDING);
};

/**
 * Handled a subscription having been unsubscribed by tag.
 */
Subscription.prototype.onUnsubscribeByTagComplete = function() {
    setState.call(this, this.STATE_UNSUBSCRIBED);
    onReadyToPerformNextAction.call(this);
};

/**
 * Returns whether this subscription is ready to be unsubscribed by tag after it has been requested.
 */
Subscription.prototype.isReadyForUnsubscribeByTag = function() {
    return this.currentState === this.STATE_READY_FOR_UNSUBSCRIBE_BY_TAG;
};

/**
 * Returns the time in ms till the subscription would be orphaned.
 * @param now - The current time as a reference (e.g. Date.now()).
 * @private
 */
Subscription.prototype.timeTillOrphaned = function(now) {
    // this works because there are no suspended and resume states.
    // once subscribed, orphan finder will be notified.
    if (
        !this.connectionAvailable ||
        this.inactivityTimeout === 0 ||
        this.currentState === this.STATE_UNSUBSCRIBED ||
        this.currentState === this.STATE_UNSUBSCRIBE_REQUESTED ||
        this.currentState === this.STATE_SUBSCRIBE_REQUESTED
    ) {
        return Infinity;
    }

    // Follows the same pattern as the old library, not giving any grace period for receiving a heartbeat
    // if it was required, it could be added on here

    const diff = now - this.latestActivity;

    return this.inactivityTimeout * 1000 - diff;
};

// -- Export section --

export default Subscription;
