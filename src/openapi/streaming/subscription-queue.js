/**
 * Queue (FIFO) of pending subscription actions. Allows for easier abstraction of managing list of pending actions.
 * In addition to standard queue implementation, provides:
 *  - merging consecutive duplicated actions
 *  - merging of uneccessary combinations: ACTION_SUBSCRIBE action before ACTION_UNSUBSCRIBE, is merged to ACTION_UNSUBSCRIBE.
 *
 * @module saxo/openapi/streaming/subscription queue
 * @ignore
 */
import {
    ACTION_SUBSCRIBE,
    ACTION_UNSUBSCRIBE,
    ACTION_MODIFY_PATCH,
    ACTION_UNSUBSCRIBE_BY_TAG_PENDING,
} from './subscription-actions';

function getLastItem() {
    if (this.isEmpty()) {
        return undefined;
    }
    return this.items[this.items.length - 1];
}

/**
 * Queue (FIFO) for storing pending subscription actions.
 * @constructor
 */
function SubscriptionQueue() {
    this.items = [];
}

/**
 * Add pending action to a queue and making sure that we remove unecessary actions like:
 * - duplicates.
 * - ACTION_SUBSCRIBE action before ACTION_UNSUBSCRIBE.
 *
 * @param {Object} queuedItem - action with arguments to add to the queue.
 */
/* eslint-disable-next-line complexity */
SubscriptionQueue.prototype.enqueue = function(queuedItem) {
    if (!queuedItem.action) {
        throw new Error('Subscription queued action is invalid');
    }
    if (this.isEmpty()) {
        this.items.push(queuedItem);
        return;
    }

    const { action } = queuedItem;
    const prevItem = getLastItem.call(this);
    const prevAction = prevItem.action;

    // unless its a patch, doing the same thing twice is a noop
    if (action === prevAction && action !== ACTION_MODIFY_PATCH) {
        // if its a unsubscribe, make sure the forces get joined
        if (
            action === ACTION_UNSUBSCRIBE &&
            queuedItem.args.force &&
            !prevItem.args.force
        ) {
            prevItem.args.force = true;
        }

        return;
    }

    if (
        // only remove the unsubscribe if it is not a forced unsubscribe
        (prevAction === ACTION_UNSUBSCRIBE &&
            action === ACTION_SUBSCRIBE &&
            !prevItem.args.force) ||
        // unsubscribing when a subscribe is queued can always eliminate the subscribe
        (prevAction === ACTION_SUBSCRIBE &&
            (action === ACTION_UNSUBSCRIBE ||
                action === ACTION_UNSUBSCRIBE_BY_TAG_PENDING)) ||
        // unsubscribing when we need to patch can happen if we are sure the unsubscribe will happen
        (prevAction === ACTION_MODIFY_PATCH &&
            ((action === ACTION_UNSUBSCRIBE && queuedItem.args.force) ||
                action === ACTION_UNSUBSCRIBE_BY_TAG_PENDING)) ||
        // We can switch a force unsubscribe for a unsubscribe by tag because there is no logic
        // to remove the unsubscribe by tag if its followed by a subscribe...
        (prevAction === ACTION_UNSUBSCRIBE &&
            action === ACTION_UNSUBSCRIBE_BY_TAG_PENDING)
    ) {
        this.items.splice(-1);

        // try again - this allows us to remove multiple items
        // e.g.
        // unsubscribe force
        // subscribe
        // unsubscribe (/by tag)
        this.enqueue(queuedItem);
        return;
    }

    this.items.push(queuedItem);
};

/**
 * This is called at the point of subscribing.
 * We know at that point we do not need any follow up patches
 * or subscribes.
 */
SubscriptionQueue.prototype.clearPatches = function() {
    const newItems = [];
    let reachedNonPatchSubscribe = false;
    for (let i = 0; i < this.items.length; i++) {
        const action = this.items[i].action;
        if (
            !reachedNonPatchSubscribe &&
            action !== ACTION_SUBSCRIBE &&
            action !== ACTION_MODIFY_PATCH
        ) {
            // The unit tests don't hit this and I can't think of a way they would
            // but I'm keeping it in because I'm not fully confident we can just reset the list
            newItems.push(this.items[i]);
            reachedNonPatchSubscribe = true;
        }
    }
    this.items = newItems;
};

/**
 * Returns the action from the beginning of a queue without removing it.
 * @return {Number} Next action.
 */
SubscriptionQueue.prototype.peekAction = function() {
    if (this.isEmpty()) {
        return undefined;
    }
    return this.items[0].action;
};

/**
 * Removes and returns the action from the beginning of a queue.
 * @return {Number|undefined} First action, if queue is not empty. Otherwise undefined.
 */
SubscriptionQueue.prototype.dequeue = function() {
    if (this.isEmpty()) {
        return undefined;
    }

    const nextItem = this.items.shift();

    if (this.isEmpty()) {
        return nextItem;
    }

    // because there might be a modify patch at the end, we see if there is a unsubscribe somewhere in the queue
    for (let i = this.items.length - 1; i >= 0; i--) {
        const item = this.items[i];
        const { action } = item;
        if (
            action === ACTION_UNSUBSCRIBE ||
            action === ACTION_UNSUBSCRIBE_BY_TAG_PENDING
        ) {
            this.items = this.items.slice(i + 1);
            return item;
        }
    }

    return nextItem;
};

/**
 * Resets queue.
 */
SubscriptionQueue.prototype.reset = function() {
    this.items = [];
};

/**
 * Returns true if queue is empty.
 * @return {boolean} True if empty.
 */
SubscriptionQueue.prototype.isEmpty = function() {
    return this.items.length === 0;
};

export default SubscriptionQueue;
