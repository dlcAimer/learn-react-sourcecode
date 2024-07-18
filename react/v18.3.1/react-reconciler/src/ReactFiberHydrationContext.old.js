/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Fiber } from './ReactInternalTypes';
import { NoMode, ConcurrentMode } from './ReactTypeOfMode';
import type {
  Instance,
  TextInstance,
  HydratableInstance,
  SuspenseInstance,
  Container,
  HostContext
} from './ReactFiberHostConfig';
import type { SuspenseState } from './ReactFiberSuspenseComponent.old';
import type { TreeContext } from './ReactFiberTreeContext.old';
import type { CapturedValue } from './ReactCapturedValue';

import {
  HostComponent,
  HostText,
  HostRoot,
  SuspenseComponent
} from './ReactWorkTags';
import {
  ChildDeletion,
  Placement,
  Hydrating,
  NoFlags,
  DidCapture
} from './ReactFiberFlags';

import {
  createFiberFromHostInstanceForDeletion,
  createFiberFromDehydratedFragment
} from './ReactFiber.old';
import {
  shouldSetTextContent,
  supportsHydration,
  canHydrateInstance,
  canHydrateTextInstance,
  canHydrateSuspenseInstance,
  getNextHydratableSibling,
  getFirstHydratableChild,
  getFirstHydratableChildWithinContainer,
  getFirstHydratableChildWithinSuspenseInstance,
  hydrateInstance,
  hydrateTextInstance,
  hydrateSuspenseInstance,
  getNextHydratableInstanceAfterSuspenseInstance,
  shouldDeleteUnhydratedTailInstances,
  didNotMatchHydratedContainerTextInstance,
  didNotMatchHydratedTextInstance,
  didNotHydrateInstanceWithinContainer,
  didNotHydrateInstanceWithinSuspenseInstance,
  didNotHydrateInstance,
  didNotFindHydratableInstanceWithinContainer,
  didNotFindHydratableTextInstanceWithinContainer,
  didNotFindHydratableSuspenseInstanceWithinContainer,
  didNotFindHydratableInstanceWithinSuspenseInstance,
  didNotFindHydratableTextInstanceWithinSuspenseInstance,
  didNotFindHydratableSuspenseInstanceWithinSuspenseInstance,
  didNotFindHydratableInstance,
  didNotFindHydratableTextInstance,
  didNotFindHydratableSuspenseInstance
} from './ReactFiberHostConfig';
import { OffscreenLane } from './ReactFiberLane.old';
import {
  getSuspendedTreeContext,
  restoreSuspendedTreeContext
} from './ReactFiberTreeContext.old';
import { queueRecoverableErrors } from './ReactFiberWorkLoop.old';

// The deepest Fiber on the stack involved in a hydration context.
// This may have been an insertion or a hydration.
let hydrationParentFiber: null | Fiber = null;
let nextHydratableInstance: null | HydratableInstance = null;
let isHydrating: boolean = false;

// This flag allows for warning supression when we expect there to be mismatches
// due to earlier mismatches or a suspended fiber.
let didSuspendOrErrorDEV: boolean = false;

// Hydration errors that were thrown inside this boundary
let hydrationErrors: Array<CapturedValue<mixed>> | null = null;

function warnIfHydrating() {
  if (__DEV__) {
    if (isHydrating) {
      console.error(
        'We should not be hydrating here. This is a bug in React. Please file a bug.'
      );
    }
  }
}

export function markDidThrowWhileHydratingDEV() {
  if (__DEV__) {
    didSuspendOrErrorDEV = true;
  }
}

export function didSuspendOrErrorWhileHydratingDEV() {
  if (__DEV__) {
    return didSuspendOrErrorDEV;
  }
  return false;
}

function enterHydrationState(fiber: Fiber): boolean {
  if (!supportsHydration) {
    return false;
  }

  // 根 dom 节点
  const parentInstance: Container = fiber.stateNode.containerInfo;
  // 下一个可以水合的 dom 实例。当前 dom 实例的第一个子元素或者兄弟元素。
  nextHydratableInstance =
    getFirstHydratableChildWithinContainer(parentInstance);
  // 当前水合的 fiber。正常情况下，该变量和 HostRoot，HostComponent 或者 HostText 类型的 workInProgress 一致。
  hydrationParentFiber = fiber;
  isHydrating = true;
  hydrationErrors = null;
  didSuspendOrErrorDEV = false;
  return true;
}

function reenterHydrationStateFromDehydratedSuspenseInstance(
  fiber: Fiber,
  suspenseInstance: SuspenseInstance,
  treeContext: TreeContext | null
): boolean {
  if (!supportsHydration) {
    return false;
  }
  nextHydratableInstance =
    getFirstHydratableChildWithinSuspenseInstance(suspenseInstance);
  hydrationParentFiber = fiber;
  isHydrating = true;
  hydrationErrors = null;
  didSuspendOrErrorDEV = false;
  if (treeContext !== null) {
    restoreSuspendedTreeContext(fiber, treeContext);
  }
  return true;
}

function warnUnhydratedInstance(
  returnFiber: Fiber,
  instance: HydratableInstance
) {
  if (__DEV__) {
    switch (returnFiber.tag) {
      case HostRoot: {
        didNotHydrateInstanceWithinContainer(
          returnFiber.stateNode.containerInfo,
          instance
        );
        break;
      }
      case HostComponent: {
        const isConcurrentMode = (returnFiber.mode & ConcurrentMode) !== NoMode;
        didNotHydrateInstance(
          returnFiber.type,
          returnFiber.memoizedProps,
          returnFiber.stateNode,
          instance,
          // TODO: Delete this argument when we remove the legacy root API.
          isConcurrentMode
        );
        break;
      }
      case SuspenseComponent: {
        const suspenseState: SuspenseState = returnFiber.memoizedState;
        if (suspenseState.dehydrated !== null)
          didNotHydrateInstanceWithinSuspenseInstance(
            suspenseState.dehydrated,
            instance
          );
        break;
      }
    }
  }
}

function deleteHydratableInstance(
  returnFiber: Fiber,
  instance: HydratableInstance
) {
  warnUnhydratedInstance(returnFiber, instance);
  const childToDelete = createFiberFromHostInstanceForDeletion();
  childToDelete.stateNode = instance;
  childToDelete.return = returnFiber;

  const deletions = returnFiber.deletions;
  if (deletions === null) {
    returnFiber.deletions = [childToDelete];
    returnFiber.flags |= ChildDeletion;
  } else {
    deletions.push(childToDelete);
  }
}

function warnNonhydratedInstance(returnFiber: Fiber, fiber: Fiber) {
  if (__DEV__) {
    if (didSuspendOrErrorDEV) {
      // Inside a boundary that already suspended. We're currently rendering the
      // siblings of a suspended node. The mismatch may be due to the missing
      // data, so it's probably a false positive.
      return;
    }

    switch (returnFiber.tag) {
      case HostRoot: {
        const parentContainer = returnFiber.stateNode.containerInfo;
        switch (fiber.tag) {
          case HostComponent:
            const type = fiber.type;
            const props = fiber.pendingProps;
            didNotFindHydratableInstanceWithinContainer(
              parentContainer,
              type,
              props
            );
            break;
          case HostText:
            const text = fiber.pendingProps;
            didNotFindHydratableTextInstanceWithinContainer(
              parentContainer,
              text
            );
            break;
          case SuspenseComponent:
            didNotFindHydratableSuspenseInstanceWithinContainer(
              parentContainer
            );
            break;
        }
        break;
      }
      case HostComponent: {
        const parentType = returnFiber.type;
        const parentProps = returnFiber.memoizedProps;
        const parentInstance = returnFiber.stateNode;
        switch (fiber.tag) {
          case HostComponent: {
            const type = fiber.type;
            const props = fiber.pendingProps;
            const isConcurrentMode =
              (returnFiber.mode & ConcurrentMode) !== NoMode;
            didNotFindHydratableInstance(
              parentType,
              parentProps,
              parentInstance,
              type,
              props,
              // TODO: Delete this argument when we remove the legacy root API.
              isConcurrentMode
            );
            break;
          }
          case HostText: {
            const text = fiber.pendingProps;
            const isConcurrentMode =
              (returnFiber.mode & ConcurrentMode) !== NoMode;
            didNotFindHydratableTextInstance(
              parentType,
              parentProps,
              parentInstance,
              text,
              // TODO: Delete this argument when we remove the legacy root API.
              isConcurrentMode
            );
            break;
          }
          case SuspenseComponent: {
            didNotFindHydratableSuspenseInstance(
              parentType,
              parentProps,
              parentInstance
            );
            break;
          }
        }
        break;
      }
      case SuspenseComponent: {
        const suspenseState: SuspenseState = returnFiber.memoizedState;
        const parentInstance = suspenseState.dehydrated;
        if (parentInstance !== null)
          switch (fiber.tag) {
            case HostComponent:
              const type = fiber.type;
              const props = fiber.pendingProps;
              didNotFindHydratableInstanceWithinSuspenseInstance(
                parentInstance,
                type,
                props
              );
              break;
            case HostText:
              const text = fiber.pendingProps;
              didNotFindHydratableTextInstanceWithinSuspenseInstance(
                parentInstance,
                text
              );
              break;
            case SuspenseComponent:
              didNotFindHydratableSuspenseInstanceWithinSuspenseInstance(
                parentInstance
              );
              break;
          }
        break;
      }
      default:
        return;
    }
  }
}
function insertNonHydratedInstance(returnFiber: Fiber, fiber: Fiber) {
  fiber.flags = (fiber.flags & ~Hydrating) | Placement;
  warnNonhydratedInstance(returnFiber, fiber);
}

function tryHydrate(
  /** 当前 fiber 节点 */
  fiber,
  /** 需要检测是否能水合的 dom 实例 */
  nextInstance
) {
  switch (fiber.tag) {
    case HostComponent: {
      const type = fiber.type;
      const props = fiber.pendingProps;
      const instance = canHydrateInstance(nextInstance, type, props);
      if (instance !== null) {
        // 成功匹配到可以水合的 dom 节点，将 dom 节点和 fiber 节点通过 stateNode 属性关联
        fiber.stateNode = (instance: Instance);
        // 当前水合的 fiber 节点
        hydrationParentFiber = fiber;
        // 将下一个用于水合的 dom 节点设置为当前 dom 节点的第一次满足条件的 子节点
        nextHydratableInstance = getFirstHydratableChild(instance);
        return true;
      }
      // 没有匹配到可以水合的 dom 节点
      return false;
    }
    case HostText: {
      const text = fiber.pendingProps;
      const textInstance = canHydrateTextInstance(nextInstance, text);
      if (textInstance !== null) {
        // 成功匹配到可以水合的 dom 节点，将 dom 节点和 fiber 节点通过 stateNode 属性关联
        fiber.stateNode = (textInstance: TextInstance);
        // 当前水合的 fiber 节点
        hydrationParentFiber = fiber;
        // Text Instances don't have children so there's nothing to hydrate.
        // 文本就是叶子节点，递归递的过程不会再继续向下
        nextHydratableInstance = null;
        return true;
      }
      return false;
    }
    case SuspenseComponent: {
      const suspenseInstance: null | SuspenseInstance =
        canHydrateSuspenseInstance(nextInstance);
      if (suspenseInstance !== null) {
        const suspenseState: SuspenseState = {
          dehydrated: suspenseInstance,
          treeContext: getSuspendedTreeContext(),
          retryLane: OffscreenLane
        };
        fiber.memoizedState = suspenseState;
        // Store the dehydrated fragment as a child fiber.
        // This simplifies the code for getHostSibling and deleting nodes,
        // since it doesn't have to consider all Suspense boundaries and
        // check if they're dehydrated ones or not.
        const dehydratedFragment =
          createFiberFromDehydratedFragment(suspenseInstance);
        dehydratedFragment.return = fiber;
        fiber.child = dehydratedFragment;
        hydrationParentFiber = fiber;
        // While a Suspense Instance does have children, we won't step into
        // it during the first pass. Instead, we'll reenter it later.
        nextHydratableInstance = null;
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

function shouldClientRenderOnMismatch(fiber: Fiber) {
  return (
    (fiber.mode & ConcurrentMode) !== NoMode &&
    (fiber.flags & DidCapture) === NoFlags
  );
}

function throwOnHydrationMismatch(fiber: Fiber) {
  throw new Error(
    'Hydration failed because the initial UI does not match what was ' +
    'rendered on the server.'
  );
}

function tryToClaimNextHydratableInstance(fiber: Fiber): void {
  if (!isHydrating) {
    return;
  }
  // nextHydratableInstance 在处理 HostRoot Fiber 逻辑时调用 enterHydrationState 初始化了
  // 并且水合过程中会被不断更新为当前等待水合的 dom 节点
  let nextInstance = nextHydratableInstance;
  if (!nextInstance) {
    if (shouldClientRenderOnMismatch(fiber)) {
      warnNonhydratedInstance((hydrationParentFiber: any), fiber);
      throwOnHydrationMismatch(fiber);
    }
    // Nothing to hydrate. Make it an insertion.
    // 设置当前节点的 flag，去除水合标记，添加插入标记
    insertNonHydratedInstance((hydrationParentFiber: any), fiber);
    // 退出水合模式
    isHydrating = false;
    hydrationParentFiber = fiber;
    return;
  }
  const firstAttemptedInstance = nextInstance;
  if (!tryHydrate(fiber, nextInstance)) {
    // 没有水合成功
    if (shouldClientRenderOnMismatch(fiber)) {
      warnNonhydratedInstance((hydrationParentFiber: any), fiber);
      throwOnHydrationMismatch(fiber);
    }
    // If we can't hydrate this instance let's try the next one.
    // We use this as a heuristic. It's based on intuition and not data so it
    // might be flawed or unnecessary.
    // 这里是基于 react 团队的经验设计，并没有理论依据
    // 采用当前 dom 节点的下一个兄弟节点再次尝试水合
    nextInstance = getNextHydratableSibling(firstAttemptedInstance);
    const prevHydrationParentFiber: Fiber = (hydrationParentFiber: any);
    if (!nextInstance || !tryHydrate(fiber, nextInstance)) {
      // Nothing to hydrate. Make it an insertion.
      // 第二次还是无法水合，不再继续尝试，当前 fiber 节点直接标记为插入
      insertNonHydratedInstance((hydrationParentFiber: any), fiber);
      // 退出水合模式
      isHydrating = false;
      hydrationParentFiber = fiber;
      return;
    }
    // We matched the next one, we'll now assume that the first one was
    // superfluous and we'll delete it. Since we can't eagerly delete it
    // we'll have to schedule a deletion. To do that, this node needs a dummy
    // fiber associated with it.
    // 兄弟节点成功水合，因此当前的 dom 节点需要被删除，但是 react 的 dom 操作是受调度的，
    // 因此需要关联到一个临时创建的 fiber 节点上，通过给 fiber 节点打上删除标记来实现
    deleteHydratableInstance(prevHydrationParentFiber, firstAttemptedInstance);
  }
}

function prepareToHydrateHostInstance(
  fiber: Fiber,
  rootContainerInstance: Container,
  hostContext: HostContext
): boolean {
  if (!supportsHydration) {
    throw new Error(
      'Expected prepareToHydrateHostInstance() to never be called. ' +
      'This error is likely caused by a bug in React. Please file an issue.'
    );
  }

  const instance: Instance = fiber.stateNode;
  const shouldWarnIfMismatchDev = !didSuspendOrErrorDEV;
  const updatePayload = hydrateInstance(
    instance,
    fiber.type,
    fiber.memoizedProps,
    rootContainerInstance,
    hostContext,
    fiber,
    shouldWarnIfMismatchDev
  );
  // TODO: Type this specific to this type of component.
  fiber.updateQueue = (updatePayload: any);
  // If the update payload indicates that there is a change or if there
  // is a new ref we mark this as an update.
  if (updatePayload !== null) {
    return true;
  }
  return false;
}

function prepareToHydrateHostTextInstance(fiber: Fiber): boolean {
  if (!supportsHydration) {
    throw new Error(
      'Expected prepareToHydrateHostTextInstance() to never be called. ' +
      'This error is likely caused by a bug in React. Please file an issue.'
    );
  }

  const textInstance: TextInstance = fiber.stateNode;
  const textContent: string = fiber.memoizedProps;
  const shouldWarnIfMismatchDev = !didSuspendOrErrorDEV;
  const shouldUpdate = hydrateTextInstance(
    textInstance,
    textContent,
    fiber,
    shouldWarnIfMismatchDev
  );
  if (shouldUpdate) {
    // 需要更新，进行提示
    // We assume that prepareToHydrateHostTextInstance is called in a context where the
    // hydration parent is the parent host component of this host text.
    const returnFiber = hydrationParentFiber;
    if (returnFiber !== null) {
      switch (returnFiber.tag) {
        case HostRoot: {
          const parentContainer = returnFiber.stateNode.containerInfo;
          const isConcurrentMode =
            (returnFiber.mode & ConcurrentMode) !== NoMode;
          didNotMatchHydratedContainerTextInstance(
            parentContainer,
            textInstance,
            textContent,
            // TODO: Delete this argument when we remove the legacy root API.
            isConcurrentMode
          );
          break;
        }
        case HostComponent: {
          const parentType = returnFiber.type;
          const parentProps = returnFiber.memoizedProps;
          const parentInstance = returnFiber.stateNode;
          const isConcurrentMode =
            (returnFiber.mode & ConcurrentMode) !== NoMode;
          didNotMatchHydratedTextInstance(
            parentType,
            parentProps,
            parentInstance,
            textInstance,
            textContent,
            // TODO: Delete this argument when we remove the legacy root API.
            isConcurrentMode
          );
          break;
        }
      }
    }
  }
  return shouldUpdate;
}

function prepareToHydrateHostSuspenseInstance(fiber: Fiber): void {
  if (!supportsHydration) {
    throw new Error(
      'Expected prepareToHydrateHostSuspenseInstance() to never be called. ' +
      'This error is likely caused by a bug in React. Please file an issue.'
    );
  }

  const suspenseState: null | SuspenseState = fiber.memoizedState;
  const suspenseInstance: null | SuspenseInstance =
    suspenseState !== null ? suspenseState.dehydrated : null;

  if (!suspenseInstance) {
    throw new Error(
      'Expected to have a hydrated suspense instance. ' +
      'This error is likely caused by a bug in React. Please file an issue.'
    );
  }

  hydrateSuspenseInstance(suspenseInstance, fiber);
}

function skipPastDehydratedSuspenseInstance(
  fiber: Fiber
): null | HydratableInstance {
  if (!supportsHydration) {
    throw new Error(
      'Expected skipPastDehydratedSuspenseInstance() to never be called. ' +
      'This error is likely caused by a bug in React. Please file an issue.'
    );
  }
  const suspenseState: null | SuspenseState = fiber.memoizedState;
  const suspenseInstance: null | SuspenseInstance =
    suspenseState !== null ? suspenseState.dehydrated : null;

  if (!suspenseInstance) {
    throw new Error(
      'Expected to have a hydrated suspense instance. ' +
      'This error is likely caused by a bug in React. Please file an issue.'
    );
  }

  return getNextHydratableInstanceAfterSuspenseInstance(suspenseInstance);
}

function popToNextHostParent(fiber: Fiber): void {
  let parent = fiber.return;
  while (
    parent !== null &&
    parent.tag !== HostComponent &&
    parent.tag !== HostRoot &&
    parent.tag !== SuspenseComponent
  ) {
    parent = parent.return;
  }
  hydrationParentFiber = parent;
}

function popHydrationState(fiber: Fiber): boolean {
  if (!supportsHydration) {
    return false;
  }
  // 是否是当前水合的 fiber 节点
  if (fiber !== hydrationParentFiber) {
    // We're deeper than the current hydration context, inside an inserted
    // tree.
    // 祖先节点没有水合成功，下层节点均走插入不走水合逻辑
    return false;
  }
  if (!isHydrating) {
    // If we're not currently hydrating but we're in a hydration context, then
    // we were an insertion and now need to pop up reenter hydration of our
    // siblings.
    // 当前节点为顶层不可水合的节点，
    // 将当前水合的节点指示器 hydrationParentFiber 回退到第一个类型为 HostComponent 或 HostRoot 或 SuspenseComponent 的父节点
    popToNextHostParent(fiber);
    // 重新开始水合
    isHydrating = true;
    // react-reconciler/src/ReactFiberWorkLoop.old.js#L1953
    // completeUnitOfWork 这里的调度逻辑会将当前节点的兄弟节点设置为下一个工作目标继续水合
    return false;
  }

  // If we have any remaining hydratable nodes, we need to delete them now.
  // We only do this deeper than head and body since they tend to have random
  // other nodes in them. We also ignore components with pure text content in
  // side of them. We also don't delete anything inside the root container.
  if (
    // 不是 rootFiber
    fiber.tag !== HostRoot &&
    // 不是特定条件下的 HostComponent fiber 节点
    !(fiber.tag === HostComponent &&
      // fiber.type === 'form' || fiber.type === 'button' || shouldSetTextContent(fiber.type, fiber.memoizedProps)
      (!shouldDeleteUnhydratedTailInstances(fiber.type) ||
        // 内部是纯文本的节点
        shouldSetTextContent(fiber.type, fiber.memoizedProps)))
  ) {
    let nextInstance = nextHydratableInstance;
    if (nextInstance) {
      // 当前层级的 fiber 节点已经完成，但是同层还有可以水合 dom 的节点
      if (shouldClientRenderOnMismatch(fiber)) {
        warnIfUnhydratedTailNodes(fiber);
        throwOnHydrationMismatch(fiber);
      } else {
        while (nextInstance) {
          // 删除多余节点
          deleteHydratableInstance(fiber, nextInstance);
          // 获取下一个可以水合的兄弟 dom 节点
          nextInstance = getNextHydratableSibling(nextInstance);
        }
      }
    }
  }
  // 同上述逻辑
  popToNextHostParent(fiber);
  if (fiber.tag === SuspenseComponent) {
    //  跳过脱水的 SuspenseComponent fiber 对应的 dom 节点
    nextHydratableInstance = skipPastDehydratedSuspenseInstance(fiber);
  } else {
    nextHydratableInstance = hydrationParentFiber
      // 获取下一个可以水合的兄弟 dom 节点
      ? getNextHydratableSibling(fiber.stateNode)
      : null;
  }
  // 返回水合成功
  return true;
}

function hasUnhydratedTailNodes() {
  return isHydrating && nextHydratableInstance !== null;
}

function warnIfUnhydratedTailNodes(fiber: Fiber) {
  let nextInstance = nextHydratableInstance;
  while (nextInstance) {
    warnUnhydratedInstance(fiber, nextInstance);
    nextInstance = getNextHydratableSibling(nextInstance);
  }
}

function resetHydrationState(): void {
  if (!supportsHydration) {
    return;
  }

  hydrationParentFiber = null;
  nextHydratableInstance = null;
  isHydrating = false;
  didSuspendOrErrorDEV = false;
}

export function upgradeHydrationErrorsToRecoverable(): void {
  if (hydrationErrors !== null) {
    // Successfully completed a forced client render. The errors that occurred
    // during the hydration attempt are now recovered. We will log them in
    // commit phase, once the entire tree has finished.
    queueRecoverableErrors(hydrationErrors);
    hydrationErrors = null;
  }
}

function getIsHydrating(): boolean {
  return isHydrating;
}

export function queueHydrationError(error: CapturedValue<mixed>): void {
  if (hydrationErrors === null) {
    hydrationErrors = [error];
  } else {
    hydrationErrors.push(error);
  }
}

export {
  warnIfHydrating,
  enterHydrationState,
  getIsHydrating,
  reenterHydrationStateFromDehydratedSuspenseInstance,
  resetHydrationState,
  tryToClaimNextHydratableInstance,
  prepareToHydrateHostInstance,
  prepareToHydrateHostTextInstance,
  prepareToHydrateHostSuspenseInstance,
  popHydrationState,
  hasUnhydratedTailNodes,
  warnIfUnhydratedTailNodes
};
