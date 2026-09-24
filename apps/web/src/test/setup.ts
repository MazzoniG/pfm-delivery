import '@testing-library/jest-dom/vitest';

// Radix's popover positioning observes its trigger; jsdom ships no
// ResizeObserver, so the primitive needs this stub to mount at all.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
