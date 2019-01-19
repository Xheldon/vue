/* @flow */

import {
  warn,
  remove,
  isObject,
  parsePath,
  _Set as Set,
  handleError,
  noop
} from '../util/index'

import { traverse } from './traverse'
import { queueWatcher } from './scheduler'
import Dep, { pushTarget, popTarget } from './dep'

import type { SimpleSet } from '../util/index'

let uid = 0

/**
 * A watcher parses an expression, collects dependencies,
 * and fires callback when the expression value changes.
 * This is used for both the $watch() api and directives.
 */
export default class Watcher {
  vm: Component;
  expression: string;
  cb: Function;
  id: number;
  deep: boolean;
  user: boolean;
  lazy: boolean;
  sync: boolean;
  dirty: boolean;
  active: boolean;
  deps: Array<Dep>;
  newDeps: Array<Dep>;
  depIds: SimpleSet;
  newDepIds: SimpleSet;
  before: ?Function;
  getter: Function;
  value: any;

  constructor (
    vm: Component,
    expOrFn: string | Function,
    cb: Function,
    options?: ?Object,
    isRenderWatcher?: boolean
  ) {
    this.vm = vm
    if (isRenderWatcher) {
      vm._watcher = this
    }
    vm._watchers.push(this)
    // options
    if (options) {
      this.deep = !!options.deep
      this.user = !!options.user
      this.lazy = !!options.lazy
      this.sync = !!options.sync
      this.before = options.before
    } else {
      this.deep = this.user = this.lazy = this.sync = false
    }
    this.cb = cb
    this.id = ++uid // uid for batching
    this.active = true
    this.dirty = this.lazy // for lazy watchers
    this.deps = []
    this.newDeps = []
    this.depIds = new Set()
    this.newDepIds = new Set()
    this.expression = process.env.NODE_ENV !== 'production'
      ? expOrFn.toString()
      : ''
    // parse expression for getter
    if (typeof expOrFn === 'function') { // 触发根实例的时候(即渲染函数的观察者), 计算属性的这个参数也会是函数
      this.getter = expOrFn // watch 实例的时候是 updateComponent 函数, 该函数执行后触发 vm._render 和 vm._update
    } else { // 触发 组件的时候
      this.getter = parsePath(expOrFn) // 获取能执行取值操作的函数
      if (!this.getter) {
        this.getter = noop
        process.env.NODE_ENV !== 'production' && warn(
          `Failed watching path: "${expOrFn}" ` +
          'Watcher only accepts simple dot-delimited paths. ' +
          'For full control, use a function instead.',
          vm
        )
      }
    }
    this.value = this.lazy // 如果是计算属性, 则选项 lazy 为 false
      ? undefined
      : this.get() // 触发 get 拦截器, 收集依赖
  }

  /**
   * Evaluate the getter, and re-collect dependencies.
   */
  get () { // get 的时候可以把当前 watcher 涉及到的 属性都收集起来, 也可以把 watcher 加入到所有涉及到的响应书数据的 dep 中(因为 dep 都会把 Dep.target 加入他们的 subs 中, 而 watcher 的时候, pushTarget 的作用就是把 当前 watcher 赋值给 Dep.target)
    pushTarget(this) // 这一句直接在构造函数的静态方法上进行操作, 目的是为了跟 Dep 实例进行通信, 为了不妨碍其他的 watcher, 用完要用配套的 popTarget
    let value
    const vm = this.vm
    try {
      value = this.getter.call(vm, vm)
    } catch (e) {
      if (this.user) {
        handleError(e, vm, `getter for watcher "${this.expression}"`)
      } else {
        throw e
      }
    } finally {
      // "touch" every property so they are all tracked as
      // dependencies for deep watching
      if (this.deep) {
        traverse(value)
      }
      popTarget()
      this.cleanupDeps()
    }
    return value
  }

  /**
   * Add a dependency to this directive.
   */
  /**
   * 
   * 触发 obj 上面属性的变化, 有该属性本身闭包 dep 支持, 如果新增了一个 未被观察的属性, 则需要用到 __ob__.dep 了
   */
  addDep (dep: Dep) { // watcher 加到 dep 中
    const id = dep.id // 这个 dep 是 observe 观察的闭包中引用的 dep
    if (!this.newDepIds.has(id)) { // Set 构造函数, 防止重复 id
      this.newDepIds.add(id)
      this.newDeps.push(dep)
      // 当前函数能保证 watcher 不会有重复 dep, 但是能否保证 dep 中也之后这一个 watcher 呢?
      // 答案是可以: 这段的意思就是, 我(watcher)没添加过你(dep), 你肯定也没添加过我, 所以记录一下; 我添加了你, 你肯定添加过我; 
      if (!this.depIds.has(id)) {
        dep.addSub(this) // 加到 Dep 的 subs 里面, 等待 Dep 的 notify 逐个调用 watch 的 update 方法
      }
    }
  }

  /**
   * Clean up for dependency collection.
   */
  cleanupDeps () {
    let i = this.deps.length
    while (i--) {
      const dep = this.deps[i]
      if (!this.newDepIds.has(dep.id)) { // 上一次求值对象不存在于本次求值中, 则把 被观察对象的 watcher 移除
        dep.removeSub(this)
      }
    }
    let tmp = this.depIds // 没有必要 tmp, 直接 newDepIds 赋值给 depIds 然后清空 newDepIds 不行吗?
    this.depIds = this.newDepIds
    this.newDepIds = tmp
    this.newDepIds.clear()
    tmp = this.deps
    this.deps = this.newDeps
    this.newDeps = tmp
    this.newDeps.length = 0
  }

  /**
   * Subscriber interface.
   * Will be called when a dependency changes.
   */
  update () {
    /* istanbul ignore else */
    if (this.lazy) {
      this.dirty = true
    } else if (this.sync) {
      this.run()
    } else {
      queueWatcher(this)
    }
  }

  /**
   * Scheduler job interface.
   * Will be called by the scheduler.
   */
  run () { // set 时 => dep.notity => watcher 的 update => 最终调用 run 方法
    if (this.active) {
      const value = this.get() // get 时会执行 dep.depend 但是已经去重过了, 因此不会再收集此处的依赖
      if (
        value !== this.value ||
        // Deep watchers and watchers on Object/Arrays should fire even
        // when the value is the same, because the value may
        // have mutated.
        isObject(value) ||
        this.deep
      ) {
        // set new value
        const oldValue = this.value
        this.value = value
        if (this.user) {
          try {
            this.cb.call(this.vm, value, oldValue)
          } catch (e) {
            handleError(e, this.vm, `callback for watcher "${this.expression}"`)
          }
        } else {
          this.cb.call(this.vm, value, oldValue)
        }
      }
    }
  }

  /**
   * Evaluate the value of the watcher.
   * This only gets called for lazy watchers.
   */
  evaluate () {
    this.value = this.get()
    this.dirty = false
  }

  /**
   * Depend on all deps collected by this watcher.
   */
  depend () {
    let i = this.deps.length
    while (i--) {
      this.deps[i].depend()
    }
  }

  /**
   * Remove self from all dependencies' subscriber list.
   */
  teardown () {
    if (this.active) {
      // remove self from vm's watcher list
      // this is a somewhat expensive operation so we skip it
      // if the vm is being destroyed.
      if (!this.vm._isBeingDestroyed) {
        remove(this.vm._watchers, this)
      }
      let i = this.deps.length
      while (i--) {
        this.deps[i].removeSub(this)
      }
      this.active = false
    }
  }
}
