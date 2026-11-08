// React for runtime-loaded plugin UIs (served at /sdk/react.js): the same instance the admin UI uses.
// Named re-exports are listed because React ships as CommonJS (`export *` would drop them): its public API, minus internals.
import R from 'react'
export default R
export const {
  Activity, Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense, ViewTransition, act, addTransitionType, cache, cacheSignal, captureOwnerStack, cloneElement, createContext, createElement, createRef, forwardRef, isValidElement, lazy, memo, startTransition, use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useEffectEvent, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef, useState, useSyncExternalStore, useTransition, version,
} = R
