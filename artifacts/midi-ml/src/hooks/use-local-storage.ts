import { useState, useEffect } from "react";

export function useLocalStorage<T>(key: string, initialValue: T) {
  // 1. Pass initial state function to useState so logic is only executed once
  const [storedValue, setStoredValue] = useState<T>(initialValue);
  const [isHydrated, setIsHydrated] = useState(false);

  // 2. Safely load from localStorage ONLY on the client to prevent Hydration crashes
  useEffect(() => {
    try {
      const item = window.localStorage.getItem(key);
      if (item) {
        // We use a custom JSON parser to revive our Date objects!
        const parsed = JSON.parse(item, (key, value) => {
          // If the string looks exactly like an ISO date, cast it back to a Date object
          if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
            return new Date(value);
          }
          return value;
        });
        setStoredValue(parsed);
      }
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
    }
    setIsHydrated(true); // Tell the UI it is safe to render the loaded data
  }, [key]);

    // 3. Return a wrapped version of useState's setter function that persists the new value
    const setValue = (value: T | ((val: T) => T)) => {
        try {
        // Use React's functional updater to guarantee we always have the absolute latest state
        setStoredValue((currentValue) => {
            const valueToStore = value instanceof Function ? value(currentValue) : value;
            
            // Save to local storage
            if (typeof window !== "undefined") {
            window.localStorage.setItem(key, JSON.stringify(valueToStore));
            }
            
            return valueToStore;
        });
        } catch (error) {
        console.warn(`Error setting localStorage key "${key}":`, error);
        }
    };
    
  return [storedValue, setValue, isHydrated] as const;
}