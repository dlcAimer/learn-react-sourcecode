/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactElement} from 'shared/ReactElementType';
import type {
  ReactPortal,
  Thenable,
  ReactContext,
  ReactDebugInfo,
} from 'shared/ReactTypes';
import type {Fiber} from './ReactInternalTypes';
import type {Lanes} from './ReactFiberLane';
import type {ThenableState} from './ReactFiberThenable';

import getComponentNameFromFiber from 'react-reconciler/src/getComponentNameFromFiber';
import {
  Placement,
  ChildDeletion,
  Forked,
  PlacementDEV,
} from './ReactFiberFlags';
import {NoMode, ConcurrentMode} from './ReactTypeOfMode';
import {
  getIteratorFn,
  ASYNC_ITERATOR,
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_PORTAL_TYPE,
  REACT_LAZY_TYPE,
  REACT_CONTEXT_TYPE,
  REACT_LEGACY_ELEMENT_TYPE,
} from 'shared/ReactSymbols';
import {
  HostRoot,
  HostText,
  HostPortal,
  Fragment,
  FunctionComponent,
} from './ReactWorkTags';
import isArray from 'shared/isArray';
import {
  enableRefAsProp,
  enableAsyncIterableChildren,
  disableLegacyMode,
  enableOwnerStacks,
} from 'shared/ReactFeatureFlags';

import {
  createWorkInProgress,
  resetWorkInProgress,
  createFiberFromElement,
  createFiberFromFragment,
  createFiberFromText,
  createFiberFromPortal,
  createFiberFromThrow,
} from './ReactFiber';
import {isCompatibleFamilyForHotReloading} from './ReactFiberHotReloading';
import {getIsHydrating} from './ReactFiberHydrationContext';
import {pushTreeFork} from './ReactFiberTreeContext';
import {
  SuspenseException,
  createThenableState,
  trackUsedThenable,
} from './ReactFiberThenable';
import {readContextDuringReconciliation} from './ReactFiberNewContext';
import {callLazyInitInDEV} from './ReactFiberCallUserSpace';

import {runWithFiberInDEV} from './ReactCurrentFiber';

// This tracks the thenables that are unwrapped during reconcilation.
let thenableState: ThenableState | null = null;
let thenableIndexCounter: number = 0;

// Server Components Meta Data
let currentDebugInfo: null | ReactDebugInfo = null;

function pushDebugInfo(
  debugInfo: null | ReactDebugInfo,
): null | ReactDebugInfo {
  if (!__DEV__) {
    return null;
  }
  const previousDebugInfo = currentDebugInfo;
  if (debugInfo == null) {
    // Leave inplace
  } else if (previousDebugInfo === null) {
    currentDebugInfo = debugInfo;
  } else {
    // If we have two debugInfo, we need to create a new one. This makes the array no longer
    // live so we'll miss any future updates if we received more so ideally we should always
    // do this after both have fully resolved/unsuspended.
    currentDebugInfo = previousDebugInfo.concat(debugInfo);
  }
  return previousDebugInfo;
}

let didWarnAboutMaps;
let didWarnAboutGenerators;
let ownerHasKeyUseWarning;
let ownerHasFunctionTypeWarning;
let ownerHasSymbolTypeWarning;
let warnForMissingKey = (
  returnFiber: Fiber,
  workInProgress: Fiber,
  child: mixed,
) => {};

if (__DEV__) {
  didWarnAboutMaps = false;
  didWarnAboutGenerators = false;

  /**
   * Warn if there's no key explicitly set on dynamic arrays of children or
   * object keys are not valid. This allows us to keep track of children between
   * updates.
   */
  ownerHasKeyUseWarning = ({}: {[string]: boolean});
  ownerHasFunctionTypeWarning = ({}: {[string]: boolean});
  ownerHasSymbolTypeWarning = ({}: {[string]: boolean});

  warnForMissingKey = (
    returnFiber: Fiber,
    workInProgress: Fiber,
    child: mixed,
  ) => {
    if (child === null || typeof child !== 'object') {
      return;
    }
    if (
      !child._store ||
      ((child._store.validated || child.key != null) &&
        child._store.validated !== 2)
    ) {
      return;
    }

    if (typeof child._store !== 'object') {
      throw new Error(
        'React Component in warnForMissingKey should have a _store. ' +
          'This error is likely caused by a bug in React. Please file an issue.',
      );
    }

    // $FlowFixMe[cannot-write] unable to narrow type from mixed to writable object
    child._store.validated = 1;

    const componentName = getComponentNameFromFiber(returnFiber);

    const componentKey = componentName || 'null';
    if (ownerHasKeyUseWarning[componentKey]) {
      return;
    }
    ownerHasKeyUseWarning[componentKey] = true;

    const childOwner = child._owner;
    const parentOwner = returnFiber._debugOwner;

    let currentComponentErrorInfo = '';
    if (parentOwner && typeof parentOwner.tag === 'number') {
      const name = getComponentNameFromFiber((parentOwner: any));
      if (name) {
        currentComponentErrorInfo =
          '\n\nCheck the render method of `' + name + '`.';
      }
    }
    if (!currentComponentErrorInfo) {
      if (componentName) {
        currentComponentErrorInfo = `\n\nCheck the top-level render call using <${componentName}>.`;
      }
    }

    // Usually the current owner is the offender, but if it accepts children as a
    // property, it may be the creator of the child that's responsible for
    // assigning it a key.
    let childOwnerAppendix = '';
    if (childOwner != null && parentOwner !== childOwner) {
      let ownerName = null;
      if (typeof childOwner.tag === 'number') {
        ownerName = getComponentNameFromFiber((childOwner: any));
      } else if (typeof childOwner.name === 'string') {
        ownerName = childOwner.name;
      }
      if (ownerName) {
        // Give the component that originally created this child.
        childOwnerAppendix = ` It was passed a child from ${ownerName}.`;
      }
    }

    runWithFiberInDEV(workInProgress, () => {
      console.error(
        'Each child in a list should have a unique "key" prop.' +
          '%s%s See https://react.dev/link/warning-keys for more information.',
        currentComponentErrorInfo,
        childOwnerAppendix,
      );
    });
  };
}

// Given a fragment, validate that it can only be provided with fragment props
// We do this here instead of BeginWork because the Fragment fiber doesn't have
// the whole props object, only the children and is shared with arrays.
function validateFragmentProps(
  element: ReactElement,
  fiber: null | Fiber,
  returnFiber: Fiber,
) {
  if (__DEV__) {
    const keys = Object.keys(element.props);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key !== 'children' && key !== 'key') {
        if (fiber === null) {
          // For unkeyed root fragments there's no Fiber. We create a fake one just for
          // error stack handling.
          fiber = createFiberFromElement(element, returnFiber.mode, 0);
          fiber.return = returnFiber;
        }
        runWithFiberInDEV(
          fiber,
          erroredKey => {
            console.error(
              'Invalid prop `%s` supplied to `React.Fragment`. ' +
                'React.Fragment can only have `key` and `children` props.',
              erroredKey,
            );
          },
          key,
        );
        break;
      }
    }

    if (!enableRefAsProp && element.ref !== null) {
      if (fiber === null) {
        // For unkeyed root fragments there's no Fiber. We create a fake one just for
        // error stack handling.
        fiber = createFiberFromElement(element, returnFiber.mode, 0);
        fiber.return = returnFiber;
      }
      runWithFiberInDEV(fiber, () => {
        console.error('Invalid attribute `ref` supplied to `React.Fragment`.');
      });
    }
  }
}

function unwrapThenable<T>(thenable: Thenable<T>): T {
  const index = thenableIndexCounter;
  thenableIndexCounter += 1;
  if (thenableState === null) {
    thenableState = createThenableState();
  }
  return trackUsedThenable(thenableState, thenable, index);
}

function coerceRef(
  returnFiber: Fiber,
  current: Fiber | null,
  workInProgress: Fiber,
  element: ReactElement,
): void {
  let ref;
  if (enableRefAsProp) {
    // TODO: This is a temporary, intermediate step. When enableRefAsProp is on,
    // we should resolve the `ref` prop during the begin phase of the component
    // it's attached to (HostComponent, ClassComponent, etc).
    const refProp = element.props.ref;
    ref = refProp !== undefined ? refProp : null;
  } else {
    // Old behavior.
    ref = element.ref;
  }

  // TODO: If enableRefAsProp is on, we shouldn't use the `ref` field. We
  // should always read the ref from the prop.
  workInProgress.ref = ref;
}

function throwOnInvalidObjectType(returnFiber: Fiber, newChild: Object) {
  if (newChild.$$typeof === REACT_LEGACY_ELEMENT_TYPE) {
    throw new Error(
      'A React Element from an older version of React was rendered. ' +
        'This is not supported. It can happen if:\n' +
        '- Multiple copies of the "react" package is used.\n' +
        '- A library pre-bundled an old copy of "react" or "react/jsx-runtime".\n' +
        '- A compiler tries to "inline" JSX instead of using the runtime.',
    );
  }

  // $FlowFixMe[method-unbinding]
  const childString = Object.prototype.toString.call(newChild);

  throw new Error(
    `Objects are not valid as a React child (found: ${
      childString === '[object Object]'
        ? 'object with keys {' + Object.keys(newChild).join(', ') + '}'
        : childString
    }). ` +
      'If you meant to render a collection of children, use an array ' +
      'instead.',
  );
}

function warnOnFunctionType(returnFiber: Fiber, invalidChild: Function) {
  if (__DEV__) {
    const parentName = getComponentNameFromFiber(returnFiber) || 'Component';

    if (ownerHasFunctionTypeWarning[parentName]) {
      return;
    }
    ownerHasFunctionTypeWarning[parentName] = true;

    const name = invalidChild.displayName || invalidChild.name || 'Component';

    if (returnFiber.tag === HostRoot) {
      console.error(
        'Functions are not valid as a React child. This may happen if ' +
          'you return %s instead of <%s /> from render. ' +
          'Or maybe you meant to call this function rather than return it.\n' +
          '  root.render(%s)',
        name,
        name,
        name,
      );
    } else {
      console.error(
        'Functions are not valid as a React child. This may happen if ' +
          'you return %s instead of <%s /> from render. ' +
          'Or maybe you meant to call this function rather than return it.\n' +
          '  <%s>{%s}</%s>',
        name,
        name,
        parentName,
        name,
        parentName,
      );
    }
  }
}

function warnOnSymbolType(returnFiber: Fiber, invalidChild: symbol) {
  if (__DEV__) {
    const parentName = getComponentNameFromFiber(returnFiber) || 'Component';

    if (ownerHasSymbolTypeWarning[parentName]) {
      return;
    }
    ownerHasSymbolTypeWarning[parentName] = true;

    // eslint-disable-next-line react-internal/safe-string-coercion
    const name = String(invalidChild);

    if (returnFiber.tag === HostRoot) {
      console.error(
        'Symbols are not valid as a React child.\n' + '  root.render(%s)',
        name,
      );
    } else {
      console.error(
        'Symbols are not valid as a React child.\n' + '  <%s>%s</%s>',
        parentName,
        name,
        parentName,
      );
    }
  }
}

function resolveLazy(lazyType: any) {
  if (__DEV__) {
    return callLazyInitInDEV(lazyType);
  }
  const payload = lazyType._payload;
  const init = lazyType._init;
  return init(payload);
}

type ChildReconciler = (
  returnFiber: Fiber,
  currentFirstChild: Fiber | null,
  newChild: any,
  lanes: Lanes,
) => Fiber | null;

// This wrapper function exists because I expect to clone the code in each path
// to be able to optimize each path individually by branching early. This needs
// a compiler or we can do it manually. Helpers that don't need this branching
// live outside of this function.
function createChildReconciler(
  shouldTrackSideEffects: boolean,
): ChildReconciler {
  /**
   * 将 returnFiber 子元素中，需要删除的 fiber 节点放到 deletions 的副作用数组中
   * 该方法只删除一个节点
   * 当前 diff 时不会立即删除，而是在更新时，才会将该数组中的fiber节点进行删除
   * @param returnFiber
   * @param childToDelete
   */
  function deleteChild(returnFiber: Fiber, childToDelete: Fiber): void {
    if (!shouldTrackSideEffects) {
      // Noop.
      // 不需要收集副作用时，直接返回，不进行任何操作
      return;
    }
    const deletions = returnFiber.deletions;
    if (deletions === null) {
      // 若副作用数组为空，则创建一个
      returnFiber.deletions = [childToDelete];
      returnFiber.flags |= ChildDeletion;
    } else {
      // 否则直接推入
      deletions.push(childToDelete);
    }
  }

  /**
   * 删除 returnFiber 的子元素中，currentFirstChild 及后续所有的兄弟元素
   * 即把 currentFirstChild 及其兄弟元素，都放到 returnFiber 的 deletions 的副作用数组中，等待删除
   * 这是一个批量删除节点的方法
   * @param returnFiber 要删除节点的父级节点
   * @param currentFirstChild 当前要删除节点的起始节点
   * @returns {null}
   */
  function deleteRemainingChildren(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
  ): null {
    if (!shouldTrackSideEffects) {
      // Noop.
      // 不需要收集副作用时，直接返回，不进行任何操作
      return null;
    }

    // TODO: For the shouldClone case, this could be micro-optimized a bit by
    // assuming that after the first child we've already added everything.
    // 从 currentFirstChild 节点开始，把当前及后续所有的节点，通过 deleteChild 方法标记为删除状态
    let childToDelete = currentFirstChild;
    while (childToDelete !== null) {
      deleteChild(returnFiber, childToDelete);
      childToDelete = childToDelete.sibling;
    }
    return null;
  }

  /**
   * 将 currentFirstChild 和后续所有的兄弟节点放到 map 中，方便查找
   * 若该 fiber 节点有 key，则使用该 key 作为 map 的 key；否则使用隐性的 index 作为 map 的 key
   * @param {Fiber} currentFirstChild 要存储的链表的头节点指针
   * @returns {Map<string|number, Fiber>} 返回存储所有节点的map对象
   */
  function mapRemainingChildren(
    currentFirstChild: Fiber,
  ): Map<string | number, Fiber> {
    // Add the remaining children to a temporary map so that we can find them by
    // keys quickly. Implicit (null) keys get added to this set with their index
    // instead.
    const existingChildren: Map<string | number, Fiber> = new Map();

    let existingChild: null | Fiber = currentFirstChild;
    while (existingChild !== null) {
      if (existingChild.key !== null) {
        existingChildren.set(existingChild.key, existingChild);
      } else {
        existingChildren.set(existingChild.index, existingChild);
      }
      existingChild = existingChild.sibling;
    }
    return existingChildren;
  }

  function useFiber(fiber: Fiber, pendingProps: mixed): Fiber {
    // We currently set sibling to null and index to 0 here because it is easy
    // to forget to do before returning it. E.g. for the single child case.
    const clone = createWorkInProgress(fiber, pendingProps);
    // 将新的 fiber 节点的 index 设置为 0，sibling 设置为 null，
    // 因为目前我们还不知道这个节点用来干什么，比如他可能用于单节点的 case 中
    clone.index = 0;
    clone.sibling = null;
    return clone;
  }

  function placeChild(
    newFiber: Fiber,
    lastPlacedIndex: number,
    newIndex: number,
  ): number {
    newFiber.index = newIndex;
    if (!shouldTrackSideEffects) {
      // During hydration, the useId algorithm needs to know which fibers are
      // part of a list of children (arrays, iterators).
      /**
       * 当父亲的 current 不存在时，此时为 mount，shouldTrackSideEffects 为 false，不用做处理。
       * 当父亲的 current 存在时，shouldTrackSideEffects 为 true。
       * 例如，当遇到第一个需要重新创建的节点时，它对应的 parent 的 current 存在，标记为更新。
       * 当遍历到子节点时，由于子节点对应的 parent 的 current 不存在，此时不标记更新。
       * 这样做的好处是，只有父亲被标记为更新，而其后代均不作标记。
       * 在 completeWork 的时候子节点直接全添加到父亲上。
       * 在 commit 的时候只需要将父亲添加到 根节点上即可。
       */
      newFiber.flags |= Forked;
      return lastPlacedIndex;
    }
    const current = newFiber.alternate;
    if (current !== null) {
      const oldIndex = current.index;
      if (oldIndex < lastPlacedIndex) {
        // This is a move.
        newFiber.flags |= Placement | PlacementDEV;
        return lastPlacedIndex;
      } else {
        // This item can stay in place.
        return oldIndex;
      }
    } else {
      // This is an insertion.
      newFiber.flags |= Placement | PlacementDEV;
      return lastPlacedIndex;
    }
  }

  function placeSingleChild(newFiber: Fiber): Fiber {
    // This is simpler for the single child case. We only need to do a
    // placement for inserting new children.
    if (shouldTrackSideEffects && newFiber.alternate === null) {
      newFiber.flags |= Placement | PlacementDEV;
    }
    return newFiber;
  }

  function updateTextNode(
    returnFiber: Fiber,
    current: Fiber | null,
    textContent: string,
    lanes: Lanes,
  ) {
    if (current === null || current.tag !== HostText) {
      // Insert
      const created = createFiberFromText(textContent, returnFiber.mode, lanes);
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = currentDebugInfo;
      }
      return created;
    } else {
      // Update
      const existing = useFiber(current, textContent);
      existing.return = returnFiber;
      if (__DEV__) {
        existing._debugInfo = currentDebugInfo;
      }
      return existing;
    }
  }

  function updateElement(
    returnFiber: Fiber,
    current: Fiber | null,
    element: ReactElement,
    lanes: Lanes,
  ): Fiber {
    const elementType = element.type;
    if (elementType === REACT_FRAGMENT_TYPE) {
      const updated = updateFragment(
        returnFiber,
        current,
        element.props.children,
        lanes,
        element.key,
      );
      validateFragmentProps(element, updated, returnFiber);
      return updated;
    }
    if (current !== null) {
      if (
        current.elementType === elementType ||
        // Keep this check inline so it only runs on the false path:
        (__DEV__
          ? isCompatibleFamilyForHotReloading(current, element)
          : false) ||
        // Lazy types should reconcile their resolved type.
        // We need to do this after the Hot Reloading check above,
        // because hot reloading has different semantics than prod because
        // it doesn't resuspend. So we can't let the call below suspend.
        (typeof elementType === 'object' &&
          elementType !== null &&
          elementType.$$typeof === REACT_LAZY_TYPE &&
          resolveLazy(elementType) === current.type)
      ) {
        // Move based on index
        const existing = useFiber(current, element.props);
        coerceRef(returnFiber, current, existing, element);
        existing.return = returnFiber;
        if (__DEV__) {
          existing._debugOwner = element._owner;
          existing._debugInfo = currentDebugInfo;
        }
        return existing;
      }
    }
    // Insert
    const created = createFiberFromElement(element, returnFiber.mode, lanes);
    coerceRef(returnFiber, current, created, element);
    created.return = returnFiber;
    if (__DEV__) {
      created._debugInfo = currentDebugInfo;
    }
    return created;
  }

  function updatePortal(
    returnFiber: Fiber,
    current: Fiber | null,
    portal: ReactPortal,
    lanes: Lanes,
  ): Fiber {
    if (
      current === null ||
      current.tag !== HostPortal ||
      current.stateNode.containerInfo !== portal.containerInfo ||
      current.stateNode.implementation !== portal.implementation
    ) {
      // Insert
      const created = createFiberFromPortal(portal, returnFiber.mode, lanes);
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = currentDebugInfo;
      }
      return created;
    } else {
      // Update
      const existing = useFiber(current, portal.children || []);
      existing.return = returnFiber;
      if (__DEV__) {
        existing._debugInfo = currentDebugInfo;
      }
      return existing;
    }
  }

  function updateFragment(
    returnFiber: Fiber,
    current: Fiber | null,
    fragment: Iterable<React$Node>,
    lanes: Lanes,
    key: null | string,
  ): Fiber {
    if (current === null || current.tag !== Fragment) {
      // Insert
      const created = createFiberFromFragment(
        fragment,
        returnFiber.mode,
        lanes,
        key,
      );
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = currentDebugInfo;
      }
      return created;
    } else {
      // Update
      const existing = useFiber(current, fragment);
      existing.return = returnFiber;
      if (__DEV__) {
        existing._debugInfo = currentDebugInfo;
      }
      return existing;
    }
  }

  function createChild(
    returnFiber: Fiber,
    newChild: any,
    lanes: Lanes,
  ): Fiber | null {
    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      typeof newChild === 'bigint'
    ) {
      // Text nodes don't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      const created = createFiberFromText(
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        returnFiber.mode,
        lanes,
      );
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = currentDebugInfo;
      }
      return created;
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const created = createFiberFromElement(
            newChild,
            returnFiber.mode,
            lanes,
          );
          coerceRef(returnFiber, null, created, newChild);
          created.return = returnFiber;
          if (__DEV__) {
            const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
            created._debugInfo = currentDebugInfo;
            currentDebugInfo = prevDebugInfo;
          }
          return created;
        }
        case REACT_PORTAL_TYPE: {
          const created = createFiberFromPortal(
            newChild,
            returnFiber.mode,
            lanes,
          );
          created.return = returnFiber;
          if (__DEV__) {
            created._debugInfo = currentDebugInfo;
          }
          return created;
        }
        case REACT_LAZY_TYPE: {
          const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
          let resolvedChild;
          if (__DEV__) {
            resolvedChild = callLazyInitInDEV(newChild);
          } else {
            const payload = newChild._payload;
            const init = newChild._init;
            resolvedChild = init(payload);
          }
          const created = createChild(returnFiber, resolvedChild, lanes);
          currentDebugInfo = prevDebugInfo;
          return created;
        }
      }

      if (
        isArray(newChild) ||
        getIteratorFn(newChild) ||
        (enableAsyncIterableChildren &&
          typeof newChild[ASYNC_ITERATOR] === 'function')
      ) {
        const created = createFiberFromFragment(
          newChild,
          returnFiber.mode,
          lanes,
          null,
        );
        created.return = returnFiber;
        if (__DEV__) {
          const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
          created._debugInfo = currentDebugInfo;
          currentDebugInfo = prevDebugInfo;
        }
        return created;
      }

      // Usable node types
      //
      // Unwrap the inner value and recursively call this function again.
      if (typeof newChild.then === 'function') {
        const thenable: Thenable<any> = (newChild: any);
        const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
        const created = createChild(
          returnFiber,
          unwrapThenable(thenable),
          lanes,
        );
        currentDebugInfo = prevDebugInfo;
        return created;
      }

      if (newChild.$$typeof === REACT_CONTEXT_TYPE) {
        const context: ReactContext<mixed> = (newChild: any);
        return createChild(
          returnFiber,
          readContextDuringReconciliation(returnFiber, context, lanes),
          lanes,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType(returnFiber, newChild);
      }
      if (typeof newChild === 'symbol') {
        warnOnSymbolType(returnFiber, newChild);
      }
    }

    return null;
  }

  /**
   * 创建或更新 element 结构 newChild 为 fiber 节点
   * 若 oldFiber 不为空，且 newChild 与 oldFiber 的 key 能对得上，则复用旧 fiber 节点
   * 否则，创建一个新的 fiber 节点
   * 该 updateSlot 方法与 createChild 方法很像，但 createChild 只有创建新 fiber 节点的功能
   * 而该 updateSlot 方法则可以根据 oldFiber，来决定是复用之前的 fiber 节点，还是新创建节点
   * @param returnFiber
   * @param oldFiber
   * @param newChild
   * @param lanes
   * @returns {Fiber|null}
   */
  function updateSlot(
    returnFiber: Fiber,
    oldFiber: Fiber | null,
    newChild: any,
    lanes: Lanes,
  ): Fiber | null {
    // Update the fiber if the keys match, otherwise return null.
    const key = oldFiber !== null ? oldFiber.key : null;

    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      typeof newChild === 'bigint'
    ) {
      // Text nodes don't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      // 文本节点本身是没有 key 的，若旧 fiber 节点有 key，则说明无法复用
      if (key !== null) {
        return null;
      }
      // 若旧 fiber 没有 key，即使他不是文本节点，我们也尝试复用
      return updateTextNode(
        returnFiber,
        oldFiber,
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        lanes,
      );
    }

    if (typeof newChild === 'object' && newChild !== null) {
      // 若是一些 ReactElement 类型的，则判断 key 是否相等；相等则复用；不相等则返回 null
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          if (newChild.key === key) {
            const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
            const updated = updateElement(
              returnFiber,
              oldFiber,
              newChild,
              lanes,
            );
            currentDebugInfo = prevDebugInfo;
            return updated;
          } else {
            return null;
          }
        }
        case REACT_PORTAL_TYPE: {
          if (newChild.key === key) {
            return updatePortal(returnFiber, oldFiber, newChild, lanes);
          } else {
            return null;
          }
        }
        case REACT_LAZY_TYPE: {
          const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
          let resolvedChild;
          if (__DEV__) {
            resolvedChild = callLazyInitInDEV(newChild);
          } else {
            const payload = newChild._payload;
            const init = newChild._init;
            resolvedChild = init(payload);
          }
          const updated = updateSlot(
            returnFiber,
            oldFiber,
            resolvedChild,
            lanes,
          );
          currentDebugInfo = prevDebugInfo;
          return updated;
        }
      }

      if (
        isArray(newChild) ||
        getIteratorFn(newChild) ||
        (enableAsyncIterableChildren &&
          typeof newChild[ASYNC_ITERATOR] === 'function')
      ) {
        // 当前是数组或其他迭代类型，本身是没有 key 的，若 oldFiber 有 key，则无法复用
        if (key !== null) {
          return null;
        }

        const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
        // 若 newChild 是数组或者迭代类型，则更新为 fragment 类型
        const updated = updateFragment(
          returnFiber,
          oldFiber,
          newChild,
          lanes,
          null,
        );
        currentDebugInfo = prevDebugInfo;
        return updated;
      }

      // Usable node types
      //
      // Unwrap the inner value and recursively call this function again.
      if (typeof newChild.then === 'function') {
        const thenable: Thenable<any> = (newChild: any);
        const prevDebugInfo = pushDebugInfo((thenable: any)._debugInfo);
        const updated = updateSlot(
          returnFiber,
          oldFiber,
          unwrapThenable(thenable),
          lanes,
        );
        currentDebugInfo = prevDebugInfo;
        return updated;
      }

      if (newChild.$$typeof === REACT_CONTEXT_TYPE) {
        const context: ReactContext<mixed> = (newChild: any);
        return updateSlot(
          returnFiber,
          oldFiber,
          readContextDuringReconciliation(returnFiber, context, lanes),
          lanes,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType(returnFiber, newChild);
      }
      if (typeof newChild === 'symbol') {
        warnOnSymbolType(returnFiber, newChild);
      }
    }

    // 其他类型不进行处理，直接返回 null
    return null;
  }

  function updateFromMap(
    existingChildren: Map<string | number, Fiber>,
    returnFiber: Fiber,
    newIdx: number,
    newChild: any,
    lanes: Lanes,
  ): Fiber | null {
    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      typeof newChild === 'bigint'
    ) {
      // Text nodes don't have keys, so we neither have to check the old nor
      // new node for the key. If both are text nodes, they match.
      const matchedFiber = existingChildren.get(newIdx) || null;
      return updateTextNode(
        returnFiber,
        matchedFiber,
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        lanes,
      );
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const matchedFiber =
            existingChildren.get(
              newChild.key === null ? newIdx : newChild.key,
            ) || null;
          const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
          const updated = updateElement(
            returnFiber,
            matchedFiber,
            newChild,
            lanes,
          );
          currentDebugInfo = prevDebugInfo;
          return updated;
        }
        case REACT_PORTAL_TYPE: {
          const matchedFiber =
            existingChildren.get(
              newChild.key === null ? newIdx : newChild.key,
            ) || null;
          return updatePortal(returnFiber, matchedFiber, newChild, lanes);
        }
        case REACT_LAZY_TYPE: {
          const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
          let resolvedChild;
          if (__DEV__) {
            resolvedChild = callLazyInitInDEV(newChild);
          } else {
            const payload = newChild._payload;
            const init = newChild._init;
            resolvedChild = init(payload);
          }
          const updated = updateFromMap(
            existingChildren,
            returnFiber,
            newIdx,
            resolvedChild,
            lanes,
          );
          currentDebugInfo = prevDebugInfo;
          return updated;
        }
      }

      if (
        isArray(newChild) ||
        getIteratorFn(newChild) ||
        (enableAsyncIterableChildren &&
          typeof newChild[ASYNC_ITERATOR] === 'function')
      ) {
        const matchedFiber = existingChildren.get(newIdx) || null;
        const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
        const updated = updateFragment(
          returnFiber,
          matchedFiber,
          newChild,
          lanes,
          null,
        );
        currentDebugInfo = prevDebugInfo;
        return updated;
      }

      // Usable node types
      //
      // Unwrap the inner value and recursively call this function again.
      if (typeof newChild.then === 'function') {
        const thenable: Thenable<any> = (newChild: any);
        const prevDebugInfo = pushDebugInfo((thenable: any)._debugInfo);
        const updated = updateFromMap(
          existingChildren,
          returnFiber,
          newIdx,
          unwrapThenable(thenable),
          lanes,
        );
        currentDebugInfo = prevDebugInfo;
        return updated;
      }

      if (newChild.$$typeof === REACT_CONTEXT_TYPE) {
        const context: ReactContext<mixed> = (newChild: any);
        return updateFromMap(
          existingChildren,
          returnFiber,
          newIdx,
          readContextDuringReconciliation(returnFiber, context, lanes),
          lanes,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType(returnFiber, newChild);
      }
      if (typeof newChild === 'symbol') {
        warnOnSymbolType(returnFiber, newChild);
      }
    }

    return null;
  }

  /**
   * Warns if there is a duplicate or missing key
   */
  function warnOnInvalidKey(
    returnFiber: Fiber,
    workInProgress: Fiber,
    child: mixed,
    knownKeys: Set<string> | null,
  ): Set<string> | null {
    if (__DEV__) {
      if (typeof child !== 'object' || child === null) {
        return knownKeys;
      }
      switch (child.$$typeof) {
        case REACT_ELEMENT_TYPE:
        case REACT_PORTAL_TYPE:
          warnForMissingKey(returnFiber, workInProgress, child);
          const key = child.key;
          if (typeof key !== 'string') {
            break;
          }
          if (knownKeys === null) {
            knownKeys = new Set();
            knownKeys.add(key);
            break;
          }
          if (!knownKeys.has(key)) {
            knownKeys.add(key);
            break;
          }
          runWithFiberInDEV(workInProgress, () => {
            console.error(
              'Encountered two children with the same key, `%s`. ' +
                'Keys should be unique so that components maintain their identity ' +
                'across updates. Non-unique keys may cause children to be ' +
                'duplicated and/or omitted — the behavior is unsupported and ' +
                'could change in a future version.',
              key,
            );
          });
          break;
        case REACT_LAZY_TYPE: {
          let resolvedChild;
          if (__DEV__) {
            resolvedChild = callLazyInitInDEV((child: any));
          } else {
            const payload = child._payload;
            const init = (child._init: any);
            resolvedChild = init(payload);
          }
          warnOnInvalidKey(
            returnFiber,
            workInProgress,
            resolvedChild,
            knownKeys,
          );
          break;
        }
        default:
          break;
      }
    }
    return knownKeys;
  }

  function reconcileChildrenArray(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildren: Array<any>,
    lanes: Lanes,
  ): Fiber | null {
    // This algorithm can't optimize by searching from both ends since we
    // don't have backpointers on fibers. I'm trying to see how far we can get
    // with that model. If it ends up not being worth the tradeoffs, we can
    // add it later.

    // Even with a two ended optimization, we'd want to optimize for the case
    // where there are few changes and brute force the comparison instead of
    // going for the Map. It'd like to explore hitting that path first in
    // forward-only mode and only go for the Map once we notice that we need
    // lots of look ahead. This doesn't handle reversal as well as two ended
    // search but that's unusual. Besides, for the two ended optimization to
    // work on Iterables, we'd need to copy the whole set.

    // In this first iteration, we'll just live with hitting the bad case
    // (adding everything to a Map) in for every insert/move.

    // If you change this code, also update reconcileChildrenIterator() which
    // uses the same algorithm.

    let knownKeys: Set<string> | null = null;
    // 新构建出来的 fiber 链表的头节点
    let resultingFirstChild: Fiber | null = null;
    // 新构建出来链表的最后那个 fiber 节点，用于构建整个链表
    let previousNewFiber: Fiber | null = null;
    // 旧链表的节点，刚开始指向到第1个节点
    let oldFiber = currentFirstChild;
    // 表示当前已经新建的 Fiber 的 index 的最大值，用于判断是插入操作，还是移动操作等
    let lastPlacedIndex = 0;
    // 表示遍历 newChildren 的索引指针
    let newIdx = 0;
    // 下次循环要处理的 fiber 节点
    let nextOldFiber = null;
    for (; oldFiber !== null && newIdx < newChildren.length; newIdx++) {
      if (oldFiber.index > newIdx) {
        /**
         * oldIndex 大于 newIndex，那么需要旧的 fiber 等待新的 fiber，一直等到位置相同。
         * 那当前的 newChildren[newIdx] 则直接创建新的fiber节点
         * 当 oldFiber.index > newIdx 时，说明旧 element 对应的 newIdx 的位置的 fiber 为 null，这时将 oldFiber 设置为 null，
         * 然后调用 updateSlot 时，就不再考虑复用的问题了，直接创建新的节点。
         * 下一个旧的fiber还是当前的节点，等待 newIdx 索引相等的那个 child
         */
        nextOldFiber = oldFiber;
        oldFiber = null;
      } else {
        // 旧 fiber 的索引和 newChildren 的索引匹配上了，获取 oldFiber 的下一个兄弟节点
        nextOldFiber = oldFiber.sibling;
      }
      /**
       * 将旧节点和将要转换的 element 传进去，
       * 1. 若 key 对应上
       *  1.1 若 type 对应上，则复用之前的节点；
       *  1.2 若 type 对应不上，则直接创建新的fiber节点；
       * 2. 若 key 对应不上，无法复用，返回 null；
       * 3. 若 oldFiber 为null，则直接创建新的fiber节点；
       */
      const newFiber = updateSlot(
        returnFiber,
        oldFiber,
        newChildren[newIdx],
        lanes,
      );
      if (newFiber === null) {
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        /**
         * 新fiber节点为 null，退出循环。
         * 不过这里为null的原因有很多，比如：
         * 1. newChildren[newIdx] 本身就是无法转为 fiber 的类型，如null, boolean, undefined等；
         * 2. oldFiber 和 newChildren[newIdx] 的 key 没有匹配上；
         */
        if (oldFiber === null) {
          oldFiber = nextOldFiber;
        }
        break;
      }

      if (__DEV__) {
        knownKeys = warnOnInvalidKey(
          returnFiber,
          newFiber,
          newChildren[newIdx],
          knownKeys,
        );
      }

      if (shouldTrackSideEffects) {
        if (oldFiber && newFiber.alternate === null) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          // 若旧 fiber 节点存在，但新节点并没有复用该节点，则将该旧节点删除
          deleteChild(returnFiber, oldFiber);
        }
      }
      /**
       * 此方法是一种顺序优化手段，lastPlacedIndex 一直在更新，初始为 0，
       * 表示访问过的节点在旧集合中最右的位置（即最大的位置）。
       */
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      /**
       * resultingFirstChild：新 fiber 链表的头节点
       * previousNewFiber：用于拼接整个链表
       */
      if (previousNewFiber === null) {
        // TODO: Move out of the loop. This only happens for the first run.
        // 若整个链表为空，则头指针指向到 newFiber
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        // 若链表不为空，则将 newFiber 放到链表的后面
        previousNewFiber.sibling = newFiber;
      }
      // 指向到当前节点，方便下次拼接
      previousNewFiber = newFiber;
      // 下一个旧fiber节点
      oldFiber = nextOldFiber;
    }

    // 新索引 newIdx 跟 newChildren 的长度一样，说明新数组已遍历完毕
    // 老数组后面可能有剩余的，需要删除
    if (newIdx === newChildren.length) {
      // We've reached the end of the new children. We can delete the rest.
      // 删除旧链表中剩余的节点
      deleteRemainingChildren(returnFiber, oldFiber);
      if (getIsHydrating()) {
        const numberOfForks = newIdx;
        pushTreeFork(returnFiber, numberOfForks);
      }
      // 返回新链表的头节点指针
      return resultingFirstChild;
    }

    // 若旧数据中所有的节点都复用了，说明新数组可能还有剩余
    if (oldFiber === null) {
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      // 这里已经没有旧的fiber节点可以复用了，然后我们就选择直接创建的方式
      for (; newIdx < newChildren.length; newIdx++) {
        const newFiber = createChild(returnFiber, newChildren[newIdx], lanes);
        if (newFiber === null) {
          continue;
        }
        if (__DEV__) {
          knownKeys = warnOnInvalidKey(
            returnFiber,
            newFiber,
            newChildren[newIdx],
            knownKeys,
          );
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        // 接着上面的链表往后拼接
        if (previousNewFiber === null) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      if (getIsHydrating()) {
        const numberOfForks = newIdx;
        pushTreeFork(returnFiber, numberOfForks);
      }
      // 返回新链表的头节点指针
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    const existingChildren = mapRemainingChildren(oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    for (; newIdx < newChildren.length; newIdx++) {
      // 从 map 中查找是否存在可以复用的fiber节点，然后生成新的fiber节点
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        newChildren[newIdx],
        lanes,
      );
      if (newFiber !== null) {
        if (__DEV__) {
          knownKeys = warnOnInvalidKey(
            returnFiber,
            newFiber,
            newChildren[newIdx],
            knownKeys,
          );
        }
        // 这里只处理 newFiber 不为null的情况
        if (shouldTrackSideEffects) {
          if (newFiber.alternate !== null) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            /**
             * newFiber.alternate 指向到 current，若 current 不为空，说明复用了该 fiber 节点，
             * 这里我们要在 map 中删除，因为后面会把 map 中剩余未复用的节点删除掉的，
             * 所以这里我们要及时把已复用的节点从 map 中剔除掉
             */
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key,
            );
          }
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        // 接着之前的链表进行拼接
        if (previousNewFiber === null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      // 将 map 中没有复用的 fiber 节点添加到删除的副作用队列中，等待删除
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    if (getIsHydrating()) {
      const numberOfForks = newIdx;
      pushTreeFork(returnFiber, numberOfForks);
    }
    // 返回新链表的头节点指针
    return resultingFirstChild;
  }

  function reconcileChildrenIteratable(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildrenIterable: Iterable<mixed>,
    lanes: Lanes,
  ): Fiber | null {
    // This is the same implementation as reconcileChildrenArray(),
    // but using the iterator instead.

    const iteratorFn = getIteratorFn(newChildrenIterable);

    if (typeof iteratorFn !== 'function') {
      throw new Error(
        'An object is not an iterable. This error is likely caused by a bug in ' +
          'React. Please file an issue.',
      );
    }

    const newChildren = iteratorFn.call(newChildrenIterable);

    if (__DEV__) {
      if (newChildren === newChildrenIterable) {
        // We don't support rendering Generators as props because it's a mutation.
        // See https://github.com/facebook/react/issues/12995
        // We do support generators if they were created by a GeneratorFunction component
        // as its direct child since we can recreate those by rerendering the component
        // as needed.
        const isGeneratorComponent =
          returnFiber.tag === FunctionComponent &&
          // $FlowFixMe[method-unbinding]
          Object.prototype.toString.call(returnFiber.type) ===
            '[object GeneratorFunction]' &&
          // $FlowFixMe[method-unbinding]
          Object.prototype.toString.call(newChildren) === '[object Generator]';
        if (!isGeneratorComponent) {
          if (!didWarnAboutGenerators) {
            console.error(
              'Using Iterators as children is unsupported and will likely yield ' +
                'unexpected results because enumerating a generator mutates it. ' +
                'You may convert it to an array with `Array.from()` or the ' +
                '`[...spread]` operator before rendering. You can also use an ' +
                'Iterable that can iterate multiple times over the same items.',
            );
          }
          didWarnAboutGenerators = true;
        }
      } else if ((newChildrenIterable: any).entries === iteratorFn) {
        // Warn about using Maps as children
        if (!didWarnAboutMaps) {
          console.error(
            'Using Maps as children is not supported. ' +
              'Use an array of keyed ReactElements instead.',
          );
          didWarnAboutMaps = true;
        }
      }
    }

    return reconcileChildrenIterator(
      returnFiber,
      currentFirstChild,
      newChildren,
      lanes,
    );
  }

  function reconcileChildrenAsyncIteratable(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildrenIterable: AsyncIterable<mixed>,
    lanes: Lanes,
  ): Fiber | null {
    const newChildren = newChildrenIterable[ASYNC_ITERATOR]();

    if (__DEV__) {
      if (newChildren === newChildrenIterable) {
        // We don't support rendering AsyncGenerators as props because it's a mutation.
        // We do support generators if they were created by a AsyncGeneratorFunction component
        // as its direct child since we can recreate those by rerendering the component
        // as needed.
        const isGeneratorComponent =
          returnFiber.tag === FunctionComponent &&
          // $FlowFixMe[method-unbinding]
          Object.prototype.toString.call(returnFiber.type) ===
            '[object AsyncGeneratorFunction]' &&
          // $FlowFixMe[method-unbinding]
          Object.prototype.toString.call(newChildren) ===
            '[object AsyncGenerator]';
        if (!isGeneratorComponent) {
          if (!didWarnAboutGenerators) {
            console.error(
              'Using AsyncIterators as children is unsupported and will likely yield ' +
                'unexpected results because enumerating a generator mutates it. ' +
                'You can use an AsyncIterable that can iterate multiple times over ' +
                'the same items.',
            );
          }
          didWarnAboutGenerators = true;
        }
      }
    }

    if (newChildren == null) {
      throw new Error('An iterable object provided no iterator.');
    }

    // To save bytes, we reuse the logic by creating a synchronous Iterable and
    // reusing that code path.
    const iterator: Iterator<mixed> = ({
      next(): IteratorResult<mixed, void> {
        return unwrapThenable(newChildren.next());
      },
    }: any);

    return reconcileChildrenIterator(
      returnFiber,
      currentFirstChild,
      iterator,
      lanes,
    );
  }

  function reconcileChildrenIterator(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildren: ?Iterator<mixed>,
    lanes: Lanes,
  ): Fiber | null {
    if (newChildren == null) {
      throw new Error('An iterable object provided no iterator.');
    }

    let resultingFirstChild: Fiber | null = null;
    let previousNewFiber: Fiber | null = null;

    let oldFiber = currentFirstChild;
    let lastPlacedIndex = 0;
    let newIdx = 0;
    let nextOldFiber = null;

    let knownKeys: Set<string> | null = null;

    let step = newChildren.next();
    for (
      ;
      oldFiber !== null && !step.done;
      newIdx++, step = newChildren.next()
    ) {
      if (oldFiber.index > newIdx) {
        nextOldFiber = oldFiber;
        oldFiber = null;
      } else {
        nextOldFiber = oldFiber.sibling;
      }
      const newFiber = updateSlot(returnFiber, oldFiber, step.value, lanes);
      if (newFiber === null) {
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        if (oldFiber === null) {
          oldFiber = nextOldFiber;
        }
        break;
      }

      if (__DEV__) {
        knownKeys = warnOnInvalidKey(
          returnFiber,
          newFiber,
          step.value,
          knownKeys,
        );
      }

      if (shouldTrackSideEffects) {
        if (oldFiber && newFiber.alternate === null) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          deleteChild(returnFiber, oldFiber);
        }
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (previousNewFiber === null) {
        // TODO: Move out of the loop. This only happens for the first run.
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        previousNewFiber.sibling = newFiber;
      }
      previousNewFiber = newFiber;
      oldFiber = nextOldFiber;
    }

    if (step.done) {
      // We've reached the end of the new children. We can delete the rest.
      deleteRemainingChildren(returnFiber, oldFiber);
      if (getIsHydrating()) {
        const numberOfForks = newIdx;
        pushTreeFork(returnFiber, numberOfForks);
      }
      return resultingFirstChild;
    }

    if (oldFiber === null) {
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      for (; !step.done; newIdx++, step = newChildren.next()) {
        const newFiber = createChild(returnFiber, step.value, lanes);
        if (newFiber === null) {
          continue;
        }
        if (__DEV__) {
          knownKeys = warnOnInvalidKey(
            returnFiber,
            newFiber,
            step.value,
            knownKeys,
          );
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      if (getIsHydrating()) {
        const numberOfForks = newIdx;
        pushTreeFork(returnFiber, numberOfForks);
      }
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    const existingChildren = mapRemainingChildren(oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    for (; !step.done; newIdx++, step = newChildren.next()) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        step.value,
        lanes,
      );
      if (newFiber !== null) {
        if (__DEV__) {
          knownKeys = warnOnInvalidKey(
            returnFiber,
            newFiber,
            step.value,
            knownKeys,
          );
        }
        if (shouldTrackSideEffects) {
          if (newFiber.alternate !== null) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key,
            );
          }
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    if (getIsHydrating()) {
      const numberOfForks = newIdx;
      pushTreeFork(returnFiber, numberOfForks);
    }
    return resultingFirstChild;
  }

  // 调度文本节点
  function reconcileSingleTextNode(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    textContent: string,
    lanes: Lanes,
  ): Fiber {
    // There's no need to check for keys on text nodes since we don't have a
    // way to define them.
    // 这里不再判断文本节点的key，因为文本节点就来没有key，也没有兄弟节点
    if (currentFirstChild !== null && currentFirstChild.tag === HostText) {
      // We already have an existing node so let's just update it and delete
      // the rest.
      // 若当前第1个子节点就是文本节点，则直接删除后续的兄弟节点
      deleteRemainingChildren(returnFiber, currentFirstChild.sibling);
      // 复用这个文本的fiber节点，重新赋值新的文本
      const existing = useFiber(currentFirstChild, textContent);
      existing.return = returnFiber;
      return existing;
    }
    // The existing first child is not a text node so we need to create one
    // and delete the existing ones.
    // 若不存在子节点，或者第1个子节点不是文本节点，直接将当前所有的节点都删除，然后创建出新的文本fiber节点
    deleteRemainingChildren(returnFiber, currentFirstChild);
    const created = createFiberFromText(textContent, returnFiber.mode, lanes);
    created.return = returnFiber;
    return created;
  }

  function reconcileSingleElement(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    element: ReactElement,
    lanes: Lanes,
  ): Fiber {
    // element是workInProgress中的，表示正在构建中的
    const key = element.key;
    // child: 当前正在对比的child，初始时是第1个子节点
    let child = currentFirstChild;
    // 新节点是单个节点，但无法保证之前的节点也是单个节点，
    // 这里用循环查找第一个 key 和节点类型都一样的节点，进行复用
    while (child !== null) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      // 比较 key 值是否有变化，这是复用 Fiber 节点的先决条件
      // 若找到 key 一样的节点，即使 key 都为 null，那也是节点一样
      // 注意 key 为 null 我们也认为是相等，因为单个节点没有 key 也是正常的
      if (child.key === key) {
        const elementType = element.type;
        if (elementType === REACT_FRAGMENT_TYPE) {
          // 将要构建的是 fragment 类型，然后在之前的节点里找到一个 fragment 类型的
          if (child.tag === Fragment) {
            // 已找到可复用的fiber节点，从下一个节点开始全部删除
            deleteRemainingChildren(returnFiber, child.sibling);
            // 复用 child 节点和 element.props 属性
            const existing = useFiber(child, element.props.children);
            // 重置新 Fiber 节点的 return 指针，指向当前 Fiber 节点
            existing.return = returnFiber;
            if (__DEV__) {
              existing._debugOwner = element._owner;
              existing._debugInfo = currentDebugInfo;
            }
            validateFragmentProps(element, existing, returnFiber);
            return existing;
          }
        } else {
          // 其他类型，如REACT_ELEMENT_TYPE, REACT_LAZY_TYPE等
          if (
            child.elementType === elementType ||
            // Keep this check inline so it only runs on the false path:
            (__DEV__
              ? isCompatibleFamilyForHotReloading(child, element)
              : false) ||
            // Lazy types should reconcile their resolved type.
            // We need to do this after the Hot Reloading check above,
            // because hot reloading has different semantics than prod because
            // it doesn't resuspend. So we can't let the call below suspend.
            (typeof elementType === 'object' &&
              elementType !== null &&
              elementType.$$typeof === REACT_LAZY_TYPE &&
              resolveLazy(elementType) === child.type)
          ) {
            // 已找到可复用的fiber节点，从下一个节点开始全部删除
            deleteRemainingChildren(returnFiber, child.sibling);
            // 复用 child 节点和 element.props 属性
            const existing = useFiber(child, element.props);
            // 处理 ref
            coerceRef(returnFiber, child, existing, element);
            // 重置新 Fiber 节点的 return 指针，指向当前 Fiber 节点
            existing.return = returnFiber;
            if (__DEV__) {
              existing._debugOwner = element._owner;
              existing._debugInfo = currentDebugInfo;
            }
            return existing;
          }
        }
        // Didn't match.
        // 若 key 一样，但节点类型没有匹配上，无法直接复用，则直接删除该节点和其兄弟节点，停止循环，
        // 开始走 while 后面的创建新 fiber 节点的逻辑
        deleteRemainingChildren(returnFiber, child);
        break;
      } else {
        // 若 key 不一样，不能复用，标记删除当前单个 child 节点
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    // 上面的一通循环没找到可以复用的节点，则接下来直接创建一个新的fiber节点
    if (element.type === REACT_FRAGMENT_TYPE) {
      // 若新节点的类型是 REACT_FRAGMENT_TYPE，则调用 createFiberFromFragment 方法创建 fiber 节点
      // createFiberFromFragment 也是调用的 createFiber，第1个参数指定 fragment 类型
      // 然后再调用 new FiberNode() 创建一个 fiber 节点实例
      const created = createFiberFromFragment(
        element.props.children,
        returnFiber.mode,
        lanes,
        element.key,
      );
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = currentDebugInfo;
      }
      validateFragmentProps(element, created, returnFiber);
      return created;
    } else {
      // 若新节点是其他类型，如普通的html元素、函数组件、类组件等，则会调用 createFiberFromElement
      // 这里面再接着调用 createFiberFromTypeAndProps，然后判断 element 的 type 是哪种类型
      // 然后再调用对应的 create 方法创建 fiber 节点
      const created = createFiberFromElement(element, returnFiber.mode, lanes);
      coerceRef(returnFiber, currentFirstChild, created, element);
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = currentDebugInfo;
      }
      return created;
    }
  }

  function reconcileSinglePortal(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    portal: ReactPortal,
    lanes: Lanes,
  ): Fiber {
    const key = portal.key;
    let child = currentFirstChild;
    while (child !== null) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        if (
          child.tag === HostPortal &&
          child.stateNode.containerInfo === portal.containerInfo &&
          child.stateNode.implementation === portal.implementation
        ) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(child, portal.children || []);
          existing.return = returnFiber;
          return existing;
        } else {
          deleteRemainingChildren(returnFiber, child);
          break;
        }
      } else {
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    const created = createFiberFromPortal(portal, returnFiber.mode, lanes);
    created.return = returnFiber;
    return created;
  }

  // This API will tag the children with the side-effect of the reconciliation
  // itself. They will be added to the side-effect list as we pass through the
  // children and the parent.
  // 函数 reconcileChildFibersImpl 不做实际的操作，仅是根据 element 的类型，调用不同的方法来处理，相当于一个路由分发。
  // 将 returnFiber 节点（即当前的 workInProgress 对应的节点）里的 element 结构转为 fiber 结构
  function reconcileChildFibersImpl(
    // 当前 Fiber 节点，即 workInProgress
    returnFiber: Fiber,
    // current fiber 树对应的第一个子节点
    currentFirstChild: Fiber | null,
    // 子节点的 element 结构
    newChild: any,
    lanes: Lanes,
  ): Fiber | null {
    // This function is only recursive for Usables/Lazy and not nested arrays.
    // That's so that using a Lazy wrapper is unobservable to the Fragment
    // convention.
    // If the top level item is an array, we treat it as a set of children,
    // not as a fragment. Nested arrays on the other hand will be treated as
    // fragment nodes. Recursion happens at the normal flow.

    // Handle top level unkeyed fragments as if they were arrays.
    // This leads to an ambiguity between <>{[...]}</> and <>...</>.
    // We treat the ambiguous cases above the same.
    // We don't use recursion here because a fragment inside a fragment
    // is no longer considered "top level" for these purposes.
    // 是否是顶层的没有 key 的 Fragment 组件
    const isUnkeyedTopLevelFragment =
      typeof newChild === 'object' &&
      newChild !== null &&
      newChild.type === REACT_FRAGMENT_TYPE &&
      newChild.key === null;
    if (isUnkeyedTopLevelFragment) {
      // 是就跳过 Fragment，直接操作 children
      validateFragmentProps(newChild, null, returnFiber);
      newChild = newChild.props.children;
    }

    // Handle object types
    if (typeof newChild === 'object' && newChild !== null) {
      /**
       * newChild 是 Object，再具体判断 newChild 的具体类型。
       * 1. 是普通 React 的函数组件、类组件、html标签等
       * 2. portal 类型
       * 3. lazy类型
       * 4. newChild 是一个数组，即 workInProgress 节点下有并排多个结构，这时 newChild 就是一个数组
       * 5. 其他迭代类型
       */
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          // 一般的 React 组件，如 <App /> 或 <p></p> 等
          const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
          const firstChild = placeSingleChild(
            // 调度单体 element 结构的元素
            reconcileSingleElement(
              returnFiber,
              currentFirstChild,
              newChild,
              lanes,
            ),
          );
          currentDebugInfo = prevDebugInfo;
          return firstChild;
        }
        case REACT_PORTAL_TYPE:
          return placeSingleChild(
            reconcileSinglePortal(
              returnFiber,
              currentFirstChild,
              newChild,
              lanes,
            ),
          );
        case REACT_LAZY_TYPE: {
          const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
          let result;
          if (__DEV__) {
            result = callLazyInitInDEV(newChild);
          } else {
            const payload = newChild._payload;
            const init = newChild._init;
            result = init(payload);
          }
          const firstChild = reconcileChildFibersImpl(
            returnFiber,
            currentFirstChild,
            result,
            lanes,
          );
          currentDebugInfo = prevDebugInfo;
          return firstChild;
        }
      }

      if (isArray(newChild)) {
        const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
        const firstChild = reconcileChildrenArray(
          returnFiber,
          currentFirstChild,
          newChild,
          lanes,
        );
        currentDebugInfo = prevDebugInfo;
        return firstChild;
      }

      if (getIteratorFn(newChild)) {
        const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
        const firstChild = reconcileChildrenIteratable(
          returnFiber,
          currentFirstChild,
          newChild,
          lanes,
        );
        currentDebugInfo = prevDebugInfo;
        return firstChild;
      }

      if (
        enableAsyncIterableChildren &&
        typeof newChild[ASYNC_ITERATOR] === 'function'
      ) {
        const prevDebugInfo = pushDebugInfo(newChild._debugInfo);
        const firstChild = reconcileChildrenAsyncIteratable(
          returnFiber,
          currentFirstChild,
          newChild,
          lanes,
        );
        currentDebugInfo = prevDebugInfo;
        return firstChild;
      }

      // Usables are a valid React node type. When React encounters a Usable in
      // a child position, it unwraps it using the same algorithm as `use`. For
      // example, for promises, React will throw an exception to unwind the
      // stack, then replay the component once the promise resolves.
      //
      // A difference from `use` is that React will keep unwrapping the value
      // until it reaches a non-Usable type.
      //
      // e.g. Usable<Usable<Usable<T>>> should resolve to T
      //
      // The structure is a bit unfortunate. Ideally, we shouldn't need to
      // replay the entire begin phase of the parent fiber in order to reconcile
      // the children again. This would require a somewhat significant refactor,
      // because reconcilation happens deep within the begin phase, and
      // depending on the type of work, not always at the end. We should
      // consider as an future improvement.
      if (typeof newChild.then === 'function') {
        const thenable: Thenable<any> = (newChild: any);
        const prevDebugInfo = pushDebugInfo((thenable: any)._debugInfo);
        const firstChild = reconcileChildFibersImpl(
          returnFiber,
          currentFirstChild,
          unwrapThenable(thenable),
          lanes,
        );
        currentDebugInfo = prevDebugInfo;
        return firstChild;
      }

      if (newChild.$$typeof === REACT_CONTEXT_TYPE) {
        const context: ReactContext<mixed> = (newChild: any);
        return reconcileChildFibersImpl(
          returnFiber,
          currentFirstChild,
          readContextDuringReconciliation(returnFiber, context, lanes),
          lanes,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      typeof newChild === 'bigint'
    ) {
      // 文本节点
      return placeSingleChild(
        reconcileSingleTextNode(
          returnFiber,
          currentFirstChild,
          // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
          '' + newChild,
          lanes,
        ),
      );
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType(returnFiber, newChild);
      }
      if (typeof newChild === 'symbol') {
        warnOnSymbolType(returnFiber, newChild);
      }
    }

    // Remaining cases are all treated as empty.
    // 若没有匹配到任何类型，说明当前 newChild 无法转为 fiber 节点，如 boolean 类型，null 等是无法转为 fiber 节点的
    // deleteRemainingChildren 的作用是删除 returnFiber 节点下，第2个参数传入的 fiber 节点，及后续所有的兄弟节点
    // 如 a->b->c->d-e，假如我们第2个参数传入的是c，则删除c及后续的d、e等兄弟节点，
    // 而这里，第2个参数传入的是 currentFirstChild，则意味着删除returnFiber节点下所有的子节点
    // react 的 diff 逻辑只做同层比较
    return deleteRemainingChildren(returnFiber, currentFirstChild);
  }

  function reconcileChildFibers(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChild: any,
    lanes: Lanes,
  ): Fiber | null {
    const prevDebugInfo = currentDebugInfo;
    currentDebugInfo = null;
    try {
      debugger;
      // This indirection only exists so we can reset `thenableState` at the end.
      // It should get inlined by Closure.
      thenableIndexCounter = 0;
      const firstChildFiber = reconcileChildFibersImpl(
        returnFiber,
        currentFirstChild,
        newChild,
        lanes,
      );
      thenableState = null;
      // Don't bother to reset `thenableIndexCounter` to 0 because it always gets
      // set at the beginning.
      return firstChildFiber;
    } catch (x) {
      if (
        x === SuspenseException ||
        (!disableLegacyMode &&
          (returnFiber.mode & ConcurrentMode) === NoMode &&
          typeof x === 'object' &&
          x !== null &&
          typeof x.then === 'function')
      ) {
        // Suspense exceptions need to read the current suspended state before
        // yielding and replay it using the same sequence so this trick doesn't
        // work here.
        // Suspending in legacy mode actually mounts so if we let the child
        // mount then we delete its state in an update.
        throw x;
      }
      // Something errored during reconciliation but it's conceptually a child that
      // errored and not the current component itself so we create a virtual child
      // that throws in its begin phase. That way the current component can handle
      // the error or suspending if needed.
      const throwFiber = createFiberFromThrow(x, returnFiber.mode, lanes);
      throwFiber.return = returnFiber;
      if (__DEV__) {
        const debugInfo = (throwFiber._debugInfo = currentDebugInfo);
        // Conceptually the error's owner/task should ideally be captured when the
        // Error constructor is called but neither console.createTask does this,
        // nor do we override them to capture our `owner`. So instead, we use the
        // nearest parent as the owner/task of the error. This is usually the same
        // thing when it's thrown from the same async component but not if you await
        // a promise started from a different component/task.
        throwFiber._debugOwner = returnFiber._debugOwner;
        if (enableOwnerStacks) {
          throwFiber._debugTask = returnFiber._debugTask;
        }
        if (debugInfo != null) {
          for (let i = debugInfo.length - 1; i >= 0; i--) {
            if (typeof debugInfo[i].stack === 'string') {
              throwFiber._debugOwner = (debugInfo[i]: any);
              if (enableOwnerStacks) {
                throwFiber._debugTask = debugInfo[i].task;
              }
              break;
            }
          }
        }
      }
      return throwFiber;
    } finally {
      currentDebugInfo = prevDebugInfo;
    }
  }

  return reconcileChildFibers;
}

export const reconcileChildFibers: ChildReconciler =
  createChildReconciler(true);
export const mountChildFibers: ChildReconciler = createChildReconciler(false);

export function resetChildReconcilerOnUnwind(): void {
  // On unwind, clear any pending thenables that were used.
  thenableState = null;
  thenableIndexCounter = 0;
}

export function cloneChildFibers(
  current: Fiber | null,
  workInProgress: Fiber,
): void {
  if (current !== null && workInProgress.child !== current.child) {
    throw new Error('Resuming work not yet implemented.');
  }

  if (workInProgress.child === null) {
    return;
  }

  let currentChild = workInProgress.child;
  let newChild = createWorkInProgress(currentChild, currentChild.pendingProps);
  workInProgress.child = newChild;

  newChild.return = workInProgress;
  while (currentChild.sibling !== null) {
    currentChild = currentChild.sibling;
    newChild = newChild.sibling = createWorkInProgress(
      currentChild,
      currentChild.pendingProps,
    );
    newChild.return = workInProgress;
  }
  newChild.sibling = null;
}

// Reset a workInProgress child set to prepare it for a second pass.
export function resetChildFibers(workInProgress: Fiber, lanes: Lanes): void {
  let child = workInProgress.child;
  while (child !== null) {
    resetWorkInProgress(child, lanes);
    child = child.sibling;
  }
}
