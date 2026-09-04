type Listener<T> = (value: T) => void;

/// A listener set with subscribe and emit, for module stores and the signals
/// between them. `channel<void>()` is the `useSyncExternalStore` shape.
export function channel<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(value: T) {
      for (const listener of listeners) listener(value);
    },
  };
}
