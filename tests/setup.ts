import '@testing-library/jest-dom/vitest';

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async () => undefined },
});
