/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// UpdateQueue is a linked list of prioritized updates.
//
// Like fibers, update queues come in pairs: a current queue, which represents
// the visible state of the screen, and a work-in-progress queue, which can be
// mutated and processed asynchronously before it is committed — a form of
// double buffering. If a work-in-progress render is discarded before finishing,
// we create a new work-in-progress by cloning the current queue.
//
// Both queues share a persistent, singly-linked list structure. To schedule an
// update, we append it to the end of both queues. Each queue maintains a
// pointer to first update in the persistent list that hasn't been processed.
// The work-in-progress pointer always has a position equal to or greater than
// the current queue, since we always work on that one. The current queue's
// pointer is only updated during the commit phase, when we swap in the
// work-in-progress.
//
// For example:
//
//   Current pointer:           A - B - C - D - E - F
//   Work-in-progress pointer:              D - E - F
//                                          ^
//                                          The work-in-progress queue has
//                                          processed more updates than current.
//
// The reason we append to both queues is because otherwise we might drop
// updates without ever processing them. For example, if we only add updates to
// the work-in-progress queue, some updates could be lost whenever a work-in
// -progress render restarts by cloning from current. Similarly, if we only add
// updates to the current queue, the updates will be lost whenever an already
// in-progress queue commits and swaps with the current queue. However, by
// adding to both queues, we guarantee that the update will be part of the next
// work-in-progress. (And because the work-in-progress queue becomes the
// current queue once it commits, there's no danger of applying the same
// update twice.)
//
// Prioritization
// --------------
//
// Updates are not sorted by priority, but by insertion; new updates are always
// appended to the end of the list.
//
// The priority is still important, though. When processing the update queue
// during the render phase, only the updates with sufficient priority are
// included in the result. If we skip an update because it has insufficient
// priority, it remains in the queue to be processed later, during a lower
// priority render. Crucially, all updates subsequent to a skipped update also
// remain in the queue *regardless of their priority*. That means high priority
// updates are sometimes processed twice, at two separate priorities. We also
// keep track of a base state, that represents the state before the first
// update in the queue is applied.
//
// For example:
//
//   Given a base state of '', and the following queue of updates
//
//     A1 - B2 - C1 - D2
//
//   where the number indicates the priority, and the update is applied to the
//   previous state by appending a letter, React will process these updates as
//   two separate renders, one per distinct priority level:
//
//   First render, at priority 1:
//     Base state: ''
//     Updates: [A1, C1]
//     Result state: 'AC'
//
//   Second render, at priority 2:
//     Base state: 'A'            <-  The base state does not include C1,
//                                    because B2 was skipped.
//     Updates: [B2, C1, D2]      <-  C1 was rebased on top of B2
//     Result state: 'ABCD'
//
// Because we process updates in insertion order, and rebase high priority
// updates when preceding updates are skipped, the final result is deterministic
// regardless of priority. Intermediate state may vary according to system
// resources, but the final state is always the same.

import type {Fiber, FiberRoot} from './ReactInternalTypes';
import type {Lanes, Lane} from './ReactFiberLane';

import {
  NoLane,
  NoLanes,
  OffscreenLane,
  isSubsetOfLanes,
  mergeLanes,
  removeLanes,
  isTransitionLane,
  intersectLanes,
  markRootEntangled,
} from './ReactFiberLane';
import {
  enterDisallowedContextReadInDEV,
  exitDisallowedContextReadInDEV,
} from './ReactFiberNewContext';
import {
  Callback,
  Visibility,
  ShouldCapture,
  DidCapture,
} from './ReactFiberFlags';
import getComponentNameFromFiber from './getComponentNameFromFiber';

import {debugRenderPhaseSideEffectsForStrictMode} from 'shared/ReactFeatureFlags';

import {StrictLegacyMode} from './ReactTypeOfMode';
import {
  markSkippedUpdateLanes,
  isUnsafeClassRenderPhaseUpdate,
  getWorkInProgressRootRenderLanes,
} from './ReactFiberWorkLoop';
import {
  enqueueConcurrentClassUpdate,
  unsafe_markUpdateLaneFromFiberToRoot,
} from './ReactFiberConcurrentUpdates';
import {setIsStrictModeForDevtools} from './ReactFiberDevToolsHook';

import assign from 'shared/assign';
import {
  peekEntangledActionLane,
  peekEntangledActionThenable,
} from './ReactFiberAsyncAction';

export type Update<State> = {
  lane: Lane,

  tag: 0 | 1 | 2 | 3,
  payload: any,
  callback: (() => mixed) | null,

  next: Update<State> | null,
};

export type SharedQueue<State> = {
  pending: Update<State> | null,
  lanes: Lanes,
  hiddenCallbacks: Array<() => mixed> | null,
};

export type UpdateQueue<State> = {
  baseState: State,
  firstBaseUpdate: Update<State> | null,
  lastBaseUpdate: Update<State> | null,
  shared: SharedQueue<State>,
  callbacks: Array<() => mixed> | null,
};

export const UpdateState = 0;
export const ReplaceState = 1;
export const ForceUpdate = 2;
export const CaptureUpdate = 3;

// Global state that is reset at the beginning of calling `processUpdateQueue`.
// It should only be read right after calling `processUpdateQueue`, via
// `checkHasForceUpdateAfterProcessing`.
let hasForceUpdate = false;

let didWarnUpdateInsideUpdate;
let currentlyProcessingQueue: ?SharedQueue<$FlowFixMe>;
export let resetCurrentlyProcessingQueue: () => void;
if (__DEV__) {
  didWarnUpdateInsideUpdate = false;
  currentlyProcessingQueue = null;
  resetCurrentlyProcessingQueue = () => {
    currentlyProcessingQueue = null;
  };
}

export function initializeUpdateQueue<State>(fiber: Fiber): void {
  const queue: UpdateQueue<State> = {
    baseState: fiber.memoizedState,
    firstBaseUpdate: null,
    lastBaseUpdate: null,
    shared: {
      pending: null,
      lanes: NoLanes,
      hiddenCallbacks: null,
    },
    callbacks: null,
  };
  fiber.updateQueue = queue;
}

export function cloneUpdateQueue<State>(
  current: Fiber,
  workInProgress: Fiber,
): void {
  // Clone the update queue from current. Unless it's already a clone.
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);
  const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
  if (queue === currentQueue) {
    const clone: UpdateQueue<State> = {
      baseState: currentQueue.baseState,
      firstBaseUpdate: currentQueue.firstBaseUpdate,
      lastBaseUpdate: currentQueue.lastBaseUpdate,
      shared: currentQueue.shared,
      callbacks: null,
    };
    workInProgress.updateQueue = clone;
  }
}

export function createUpdate(lane: Lane): Update<mixed> {
  const update: Update<mixed> = {
    lane,

    tag: UpdateState,
    payload: null,
    callback: null,

    next: null,
  };
  return update;
}

export function enqueueUpdate<State>(
  fiber: Fiber,
  update: Update<State>,
  lane: Lane,
): FiberRoot | null {
  const updateQueue = fiber.updateQueue;
  if (updateQueue === null) {
    // Only occurs if the fiber has been unmounted.
    return null;
  }

  const sharedQueue: SharedQueue<State> = (updateQueue: any).shared;

  if (__DEV__) {
    if (
      currentlyProcessingQueue === sharedQueue &&
      !didWarnUpdateInsideUpdate
    ) {
      const componentName = getComponentNameFromFiber(fiber);
      console.error(
        'An update (setState, replaceState, or forceUpdate) was scheduled ' +
          'from inside an update function. Update functions should be pure, ' +
          'with zero side-effects. Consider using componentDidUpdate or a ' +
          'callback.\n\nPlease update the following component: %s',
        componentName,
      );
      didWarnUpdateInsideUpdate = true;
    }
  }

  if (isUnsafeClassRenderPhaseUpdate(fiber)) {
    // This is an unsafe render phase update. Add directly to the update
    // queue so we can process it immediately during the current render.
    const pending = sharedQueue.pending;
    if (pending === null) {
      // This is the first update. Create a circular list.
      update.next = update;
    } else {
      update.next = pending.next;
      pending.next = update;
    }
    sharedQueue.pending = update;

    // Update the childLanes even though we're most likely already rendering
    // this fiber. This is for backwards compatibility in the case where you
    // update a different component during render phase than the one that is
    // currently renderings (a pattern that is accompanied by a warning).
    return unsafe_markUpdateLaneFromFiberToRoot(fiber, lane);
  } else {
    return enqueueConcurrentClassUpdate(fiber, sharedQueue, update, lane);
  }
}

export function entangleTransitions(root: FiberRoot, fiber: Fiber, lane: Lane) {
  const updateQueue = fiber.updateQueue;
  if (updateQueue === null) {
    // Only occurs if the fiber has been unmounted.
    return;
  }

  const sharedQueue: SharedQueue<mixed> = (updateQueue: any).shared;
  if (isTransitionLane(lane)) {
    let queueLanes = sharedQueue.lanes;

    // If any entangled lanes are no longer pending on the root, then they must
    // have finished. We can remove them from the shared queue, which represents
    // a superset of the actually pending lanes. In some cases we may entangle
    // more than we need to, but that's OK. In fact it's worse if we *don't*
    // entangle when we should.
    queueLanes = intersectLanes(queueLanes, root.pendingLanes);

    // Entangle the new transition lane with the other transition lanes.
    const newQueueLanes = mergeLanes(queueLanes, lane);
    sharedQueue.lanes = newQueueLanes;
    // Even if queue.lanes already include lane, we don't know for certain if
    // the lane finished since the last time we entangled it. So we need to
    // entangle it again, just to be sure.
    markRootEntangled(root, newQueueLanes);
  }
}

export function enqueueCapturedUpdate<State>(
  workInProgress: Fiber,
  capturedUpdate: Update<State>,
) {
  // Captured updates are updates that are thrown by a child during the render
  // phase. They should be discarded if the render is aborted. Therefore,
  // we should only put them on the work-in-progress queue, not the current one.
  let queue: UpdateQueue<State> = (workInProgress.updateQueue: any);

  // Check if the work-in-progress queue is a clone.
  const current = workInProgress.alternate;
  if (current !== null) {
    const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
    if (queue === currentQueue) {
      // The work-in-progress queue is the same as current. This happens when
      // we bail out on a parent fiber that then captures an error thrown by
      // a child. Since we want to append the update only to the work-in
      // -progress queue, we need to clone the updates. We usually clone during
      // processUpdateQueue, but that didn't happen in this case because we
      // skipped over the parent when we bailed out.
      let newFirst = null;
      let newLast = null;
      const firstBaseUpdate = queue.firstBaseUpdate;
      if (firstBaseUpdate !== null) {
        // Loop through the updates and clone them.
        let update: Update<State> = firstBaseUpdate;
        do {
          const clone: Update<State> = {
            lane: update.lane,

            tag: update.tag,
            payload: update.payload,
            // When this update is rebased, we should not fire its
            // callback again.
            callback: null,

            next: null,
          };
          if (newLast === null) {
            newFirst = newLast = clone;
          } else {
            newLast.next = clone;
            newLast = clone;
          }
          // $FlowFixMe[incompatible-type] we bail out when we get a null
          update = update.next;
        } while (update !== null);

        // Append the captured update the end of the cloned list.
        if (newLast === null) {
          newFirst = newLast = capturedUpdate;
        } else {
          newLast.next = capturedUpdate;
          newLast = capturedUpdate;
        }
      } else {
        // There are no base updates.
        newFirst = newLast = capturedUpdate;
      }
      queue = {
        baseState: currentQueue.baseState,
        firstBaseUpdate: newFirst,
        lastBaseUpdate: newLast,
        shared: currentQueue.shared,
        callbacks: currentQueue.callbacks,
      };
      workInProgress.updateQueue = queue;
      return;
    }
  }

  // Append the update to the end of the list.
  const lastBaseUpdate = queue.lastBaseUpdate;
  if (lastBaseUpdate === null) {
    queue.firstBaseUpdate = capturedUpdate;
  } else {
    lastBaseUpdate.next = capturedUpdate;
  }
  queue.lastBaseUpdate = capturedUpdate;
}

function getStateFromUpdate<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  update: Update<State>,
  prevState: State,
  nextProps: any,
  instance: any,
): any {
  /**
   * 可以看到下面也是区分了几种情况
   * 1. ReplaceState：舍弃掉旧状态，直接用新状态替换到旧状态；
   * 2. CaptureUpdate：捕获更新，不改变状态，直接返回旧状态
   * 2. UpdateState：新状态和旧状态的数据合并后再返回；
   * 3. ForceUpdate：只修改 hasForceUpdate 为true，不过返回的还是旧状态；
   */
  switch (update.tag) {
    case ReplaceState: {
      const payload = update.payload;
      if (typeof payload === 'function') {
        // Updater function
        /**
         * 若 payload 是 function，则将 prevState 作为参数传入，执行 payload()，
         * 直接返回该函数执行后的结果（不再与之前的数据进行合并）
         */
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
        }
        const nextState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictLegacyMode
          ) {
            setIsStrictModeForDevtools(true);
            try {
              payload.call(instance, prevState, nextProps);
            } finally {
              setIsStrictModeForDevtools(false);
            }
          }
          exitDisallowedContextReadInDEV();
        }
        return nextState;
      }
      // State object
      return payload;
    }
    case CaptureUpdate: {
      workInProgress.flags =
        (workInProgress.flags & ~ShouldCapture) | DidCapture;
    }
    // Intentional fallthrough
    case UpdateState: {
      const payload = update.payload;
      let partialState;
      if (typeof payload === 'function') {
        // Updater function
        // 若 payload 是 function，则将 prevState 作为参数传入，执行 payload()
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
        }
        partialState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictLegacyMode
          ) {
            setIsStrictModeForDevtools(true);
            try {
              payload.call(instance, prevState, nextProps);
            } finally {
              setIsStrictModeForDevtools(false);
            }
          }
          exitDisallowedContextReadInDEV();
        }
      } else {
        // Partial state object
        // 若 payload 是变量，则直接赋值
        partialState = payload;
      }
      if (partialState === null || partialState === undefined) {
        // Null and undefined are treated as no-ops.
        return prevState;
      }
      // Merge the partial state and the previous state.
      return assign({}, prevState, partialState);
    }
    case ForceUpdate: {
      hasForceUpdate = true;
      return prevState;
    }
  }
  return prevState;
}

let didReadFromEntangledAsyncAction: boolean = false;

// Each call to processUpdateQueue should be accompanied by a call to this. It's
// only in a separate function because in updateHostRoot, it must happen after
// all the context stacks have been pushed to, to prevent a stack mismatch. A
// bit unfortunate.
export function suspendIfUpdateReadFromEntangledAsyncAction() {
  // Check if this update is part of a pending async action. If so, we'll
  // need to suspend until the action has finished, so that it's batched
  // together with future updates in the same action.
  // TODO: Once we support hooks inside useMemo (or an equivalent
  // memoization boundary like Forget), hoist this logic so that it only
  // suspends if the memo boundary produces a new value.
  if (didReadFromEntangledAsyncAction) {
    const entangledActionThenable = peekEntangledActionThenable();
    if (entangledActionThenable !== null) {
      // TODO: Instead of the throwing the thenable directly, throw a
      // special object like `use` does so we can detect if it's captured
      // by userspace.
      throw entangledActionThenable;
    }
  }
}

export function processUpdateQueue<State>(
  workInProgress: Fiber,
  props: any,
  instance: any,
  renderLanes: Lanes,
): void {
  didReadFromEntangledAsyncAction = false;
  // This is always non-null on a ClassComponent or HostRoot
  // 在 HostRoot 和 ClassComponent 的 fiber 节点中，updateQueue 不可能为 null
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);

  hasForceUpdate = false;

  if (__DEV__) {
    currentlyProcessingQueue = queue.shared;
  }

  /**
   * queue.shared.pending本身是一个环形链表，即使只有一个节点，也会形成环形链表，
   * 而且 queue.shared.pending 指向的是环形链表的最后一个节点，这里将其断开形成单向链表
   * 单向链表的头指针存放到 firstBaseUpdate 中，最后一个节点则存放到 lastBaseUpdate 中
   */
  let firstBaseUpdate = queue.firstBaseUpdate;
  let lastBaseUpdate = queue.lastBaseUpdate;

  // Check if there are pending updates. If so, transfer them to the base queue.
  // 环形链表的最后一个节点
  let pendingQueue = queue.shared.pending;
  // 检测是否存在将要进行的更新，若存在，则将其拼接到 lastBaseUpdate 的后面，并清空 queue.shared.pending 链表
  if (pendingQueue !== null) {
    queue.shared.pending = null;

    // The pending queue is circular. Disconnect the pointer between first
    // and last so that it's non-circular.
    // 环形链表的最后一个节点
    const lastPendingUpdate = pendingQueue;
    // 环形链表的第一个节点
    const firstPendingUpdate = lastPendingUpdate.next;
    // 最后一个节点与第一个节点断开
    lastPendingUpdate.next = null;
    // Append pending updates to base queue
    /**
     * 将 pendingQueue 拼接到 更新链表 queue.firstBaseUpdate 的后面
     * 1. 更新链表的最后那个节点为空，说明当前更新链表为空，把要更新的首节点 firstPendingUpdate 给到 firstBaseUpdate即可；
     * 2. 若更新链表的尾节点不为空，则将要更新的首节点 firstPendingUpdate 拼接到 lastBaseUpdate 的后面；
     * 3. 拼接完毕后，lastBaseUpdate 指向到新的更新链表最后的那个节点；
     */
    if (lastBaseUpdate === null) {
      firstBaseUpdate = firstPendingUpdate;
    } else {
      lastBaseUpdate.next = firstPendingUpdate;
    }
    lastBaseUpdate = lastPendingUpdate;

    // If there's a current queue, and it's different from the base queue, then
    // we need to transfer the updates to that queue, too. Because the base
    // queue is a singly-linked list with no cycles, we can append to both
    // lists and take advantage of structural sharing.
    // TODO: Pass `current` as argument
    /**
     * 若 workInProgress 对应的在 current 的那个 fiber 节点，其更新队列的最后那个节点与当前的最后那个节点不一样，
     * 则我们将上面「将要更新」的链表的头指针和尾指针给到 current 节点的更新队列中，
     * 拼接方式与上面的一样
     */
    const current = workInProgress.alternate;
    if (current !== null) {
      // This is always non-null on a ClassComponent or HostRoot
      const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
      const currentLastBaseUpdate = currentQueue.lastBaseUpdate;
      /**
       * 若 current 更新链表的最后那个节点与当前将要更新的链表的最后那个节点不一样，
       * 则把将要更新的链表也拼接到 current 中
       */
      if (currentLastBaseUpdate !== lastBaseUpdate) {
        if (currentLastBaseUpdate === null) {
          currentQueue.firstBaseUpdate = firstPendingUpdate;
        } else {
          currentLastBaseUpdate.next = firstPendingUpdate;
        }
        currentQueue.lastBaseUpdate = lastPendingUpdate;
      }
    }
  }

  // These values may change as we process the queue.
  /**
   * 进行到这里，render() 初始更新时，放在 queue.shared.pending 中的 update 节点（里面存放着element结构），
   * 就已经放到 queue.firstBaseUpdate 里了，
   * 因此 firstBaseUpdate 里肯定存放了一个 update 节点，一定不为空，进入到 if 的逻辑中
   */
  if (firstBaseUpdate !== null) {
    // Iterate through the list of updates to compute the result.
    // 迭代更新列表以计算结果

    /**
     * newState 先拿到上次的数据，然后执行 firstBaseUpdate 链表中所有的 update，
     * 再存储每轮的结果，最后将其给到 workInProgress.memoizedState
     * 默认值：
     * {
     *  cache: {controller: AbortController, data: Map(0), refCount: 1}
     *  element: null
     *  isDehydrated: false
     *  pendingSuspenseBoundaries: null
     *  transitions: null
     * }
     */
    let newState = queue.baseState;
    // TODO: Don't need to accumulate this. Instead, we can remove renderLanes
    // from the original lanes.
    let newLanes: Lanes = NoLanes;

    /**
     * 下次渲染时的初始值
     * 1. 若存在低优先级的任务，则该 newBaseState 为第一个低优先级任务之前计算后的值；
     * 2. 若不存在低优先级的任务，则 newBaseState 为执行完所有任务后得到的值；
     */
    let newBaseState = null;
    /**
     * 下面的两个指针用来存放低优先级的更新链表，
     * 即 firstBaseUpdate 链表中，可能会存在一些优先级不够的update，
     * 若存在低优先级的 update，则将其拼接到 newFirstBaseUpdate 里，
     * 同时，既然存在低优先级的任务，为了保证整个更新的完整性，也会将已经执行 update 后的结果，也放到这个新链表中，
     * 这里存在一个问题，若低优先级任务是中间才出现的，怎么办呢？
     * 解决方案：将执行到当前 update 前的 state 设置为新链表的初始值：newBaseState = newState;
     */
    let newFirstBaseUpdate = null;
    let newLastBaseUpdate: null | Update<State> = null;

    let update: Update<State> = firstBaseUpdate;
    do {
      // An extra OffscreenLane bit is added to updates that were made to
      // a hidden tree, so that we can distinguish them from updates that were
      // already there when the tree was hidden.
      const updateLane = removeLanes(update.lane, OffscreenLane);
      const isHiddenUpdate = updateLane !== update.lane;

      // Check if this update was made while the tree was hidden. If so, then
      // it's not a "base" update and we should disregard the extra base lanes
      // that were added to renderLanes when we entered the Offscreen tree
      /**
       * 判断 updateLane 是否是 renderLanes 的子集，
       * if 这里有个取反的符号，导致理解起来可能有点困难，实际上：
       * 1. 若 update 的 lane (又名 updateLane) 是 renderLanes 的子集，则执行该 update；
       * 2. 若不是其子集，则将其放到新的队列中，等待下次的执行；
       */
      const shouldSkipUpdate = isHiddenUpdate
        ? !isSubsetOfLanes(getWorkInProgressRootRenderLanes(), updateLane)
        : !isSubsetOfLanes(renderLanes, updateLane);

      if (shouldSkipUpdate) {
        // Priority is insufficient. Skip this update. If this is the first
        // skipped update, the previous update/state is the new base
        // update/state.
        /**
         * 若当前 update 的操作的优先级不够。跳过此更新。
         * 将该 update 放到新的队列中，为了保证链式操作的连续性，下面 else 逻辑中已经可以执行的 update，也放到这个队列中。
         * 
         * 这里还有一个问题，从第一个低优先级的任务到最后都已经存储起来了，那新的初始状态是什么呢？
         * 新的初始状态就是当前跳过的 update 节点时的那个状态。新的初始状态，只有在第一个跳过任务时才需要设置。
         * 
         * 例如我们初始状态是0，有10个 update 的操作，第0个 update 的操作是+0，第1个 update 的操作是+1，第2个 update 的操作是+2，依次类推；
         * 若第4个 update 是一个低优先级的操作，其他的都是正常的优先级。
         * 那么将第4个 update 放到新的链表进行存储时，此时要存储的初始值就是执行当前节点前的值，是6（state+0+1+2+3）
         * 后续的 update 即使当前已经执行过了，也是要放到新的链表中的，否则更新就会乱掉。
         * 下次渲染时，就是以初始 state 为6，+4的那个 update 开始，重新判断优先级
         */
        const clone: Update<State> = {
          lane: updateLane,

          tag: update.tag,
          payload: update.payload,
          callback: update.callback,

          next: null,
        };
        // 拼接低优先级的任务
        if (newLastBaseUpdate === null) {
          // 还没有节点，这clone就是头结点，并将此时的 newState 放到新的 newBaseState中
          newFirstBaseUpdate = newLastBaseUpdate = clone;
          newBaseState = newState;
        } else {
          // 已经有节点了，直接向后拼接
          newLastBaseUpdate = newLastBaseUpdate.next = clone;
        }
        // Update the remaining priority in the queue.
        newLanes = mergeLanes(newLanes, updateLane);
      } else {
        // This update does have sufficient priority.
        // 此更新具有足够的优先级，初始render()时会走这里

        // Check if this update is part of a pending async action. If so,
        // we'll need to suspend until the action has finished, so that it's
        // batched together with future updates in the same action.
        if (updateLane !== NoLane && updateLane === peekEntangledActionLane()) {
          didReadFromEntangledAsyncAction = true;
        }

        if (newLastBaseUpdate !== null) {
          /**
           * 若存储低优先级的更新链表不为空，则为了操作的完整性，即使当前 update 会执行，也将当前的 update 节点也拼接到后面，
           * 但初始render()渲染时，newLastBaseUpdate为空，走不到 if 这里
           */
          const clone: Update<State> = {
            // This update is going to be committed so we never want uncommit
            // it. Using NoLane works because 0 is a subset of all bitmasks, so
            // this will never be skipped by the check above.
            lane: NoLane,

            tag: update.tag,
            payload: update.payload,

            // When this update is rebased, we should not fire its
            // callback again.
            callback: null,

            next: null,
          };
          newLastBaseUpdate = newLastBaseUpdate.next = clone;
        }

        // Process this update.
        /**
         * render()时 newState 的默认值：
         * {
         *  cache: {controller: AbortController, data: Map(0), refCount: 1}
         *  element: null
         *  isDehydrated: false
         *  pendingSuspenseBoundaries: null
         *  transitions: null
         * }
         * 执行 getStateFromUpdate() 后，则会将 update 中的 element 给到 newState 中
         */
        newState = getStateFromUpdate(
          workInProgress,
          queue,
          update,
          newState,
          props,
          instance,
        );
        const callback = update.callback;
        if (callback !== null) {
          workInProgress.flags |= Callback;
          if (isHiddenUpdate) {
            workInProgress.flags |= Visibility;
          }
          const callbacks = queue.callbacks;
          if (callbacks === null) {
            queue.callbacks = [callback];
          } else {
            callbacks.push(callback);
          }
        }
      }
      // $FlowFixMe[incompatible-type] we bail out when we get a null
      // 初始 render() 时，只有一个 update 节点，next 为 null，直接 break，跳出循环
      update = update.next;
      if (update === null) {
        /**
         * 在上面将 queue.shared.pending 放到firstBaseUpdate时，
         * queue.shared.pending就已经重置为null了
         */
        pendingQueue = queue.shared.pending;
        if (pendingQueue === null) {
          break;
        } else {
          // An update was scheduled from inside a reducer. Add the new
          // pending updates to the end of the list and keep processing.
          const lastPendingUpdate = pendingQueue;
          // Intentionally unsound. Pending updates form a circular list, but we
          // unravel them when transferring them to the base queue.
          const firstPendingUpdate =
            ((lastPendingUpdate.next: any): Update<State>);
          lastPendingUpdate.next = null;
          update = firstPendingUpdate;
          queue.lastBaseUpdate = lastPendingUpdate;
          queue.shared.pending = null;
        }
      }
    } while (true);

    if (newLastBaseUpdate === null) {
      // 若没有任意的低优先级的任务呢，则将一串的update执行后的结果，就是新的 baseState，
      // 若有低优先级的任务，则已经在上面设置过 newBaseState 了，就不能在这里设置了
      newBaseState = newState;
    }

    // 下次更新时，要使用的初始值
    queue.baseState = ((newBaseState: any): State);
    queue.firstBaseUpdate = newFirstBaseUpdate;
    queue.lastBaseUpdate = newLastBaseUpdate;

    if (firstBaseUpdate === null) {
      // `queue.lanes` is used for entangling transitions. We can set it back to
      // zero once the queue is empty.
      queue.shared.lanes = NoLanes;
    }

    // Set the remaining expiration time to be whatever is remaining in the queue.
    // This should be fine because the only two other things that contribute to
    // expiration time are props and context. We're already in the middle of the
    // begin phase by the time we start processing the queue, so we've already
    // dealt with the props. Context in components that specify
    // shouldComponentUpdate is tricky; but we'll have to account for
    // that regardless.
    markSkippedUpdateLanes(newLanes);
    workInProgress.lanes = newLanes;
    workInProgress.memoizedState = newState;
  }

  if (__DEV__) {
    currentlyProcessingQueue = null;
  }
}

function callCallback(callback: () => mixed, context: any) {
  if (typeof callback !== 'function') {
    throw new Error(
      'Invalid argument passed as callback. Expected a function. Instead ' +
        `received: ${callback}`,
    );
  }

  callback.call(context);
}

export function resetHasForceUpdateBeforeProcessing() {
  hasForceUpdate = false;
}

export function checkHasForceUpdateAfterProcessing(): boolean {
  return hasForceUpdate;
}

export function deferHiddenCallbacks<State>(
  updateQueue: UpdateQueue<State>,
): void {
  // When an update finishes on a hidden component, its callback should not
  // be fired until/unless the component is made visible again. Stash the
  // callback on the shared queue object so it can be fired later.
  const newHiddenCallbacks = updateQueue.callbacks;
  if (newHiddenCallbacks !== null) {
    const existingHiddenCallbacks = updateQueue.shared.hiddenCallbacks;
    if (existingHiddenCallbacks === null) {
      updateQueue.shared.hiddenCallbacks = newHiddenCallbacks;
    } else {
      updateQueue.shared.hiddenCallbacks =
        existingHiddenCallbacks.concat(newHiddenCallbacks);
    }
  }
}

export function commitHiddenCallbacks<State>(
  updateQueue: UpdateQueue<State>,
  context: any,
): void {
  // This component is switching from hidden -> visible. Commit any callbacks
  // that were previously deferred.
  const hiddenCallbacks = updateQueue.shared.hiddenCallbacks;
  if (hiddenCallbacks !== null) {
    updateQueue.shared.hiddenCallbacks = null;
    for (let i = 0; i < hiddenCallbacks.length; i++) {
      const callback = hiddenCallbacks[i];
      callCallback(callback, context);
    }
  }
}

export function commitCallbacks<State>(
  updateQueue: UpdateQueue<State>,
  context: any,
): void {
  const callbacks = updateQueue.callbacks;
  if (callbacks !== null) {
    updateQueue.callbacks = null;
    for (let i = 0; i < callbacks.length; i++) {
      const callback = callbacks[i];
      callCallback(callback, context);
    }
  }
}
