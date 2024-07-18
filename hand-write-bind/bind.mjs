'use strict';

const isFunction = (context) => typeof context === 'function';

/**
 * 不能使用箭头函数
 * 1. 箭头函数的 this 是上层的 this，并不是 bind 函数的调用者
 * 2. 箭头函数没有 arguments 对象
 */
function bind (context) {
  const target = this;
  // 必须是函数才能绑定
  if (!isFunction(target)) {
    throw new TypeError(
      'Function.prototype.bind - what is trying to be bound is not callable'
    );
  }

  const bindArgs = Array.prototype.slice.call(arguments, 1);

  return function () {
    const currentArgs = Array.prototype.slice.call(arguments);
    const args = bindArgs.concat(currentArgs);
    return target.apply(context, args);
  };
};

// Function.prototype.bind = Function.prototype.bind || bind;
Function.prototype.bind = bind;

function test (a, b) {
  return a + b;
}

const bindTest = test.bind(null, 1);
console.log(bindTest.length);
console.log(test.length);
