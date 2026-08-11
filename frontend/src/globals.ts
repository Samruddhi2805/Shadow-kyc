import { Buffer } from 'buffer';

// Map process.env.NODE_ENV to import.meta.env.MODE for third-party packages that require it
// @ts-expect-error process is not typed on globalThis
globalThis.process = {
  env: {
    NODE_ENV: import.meta.env.MODE,
  },
};

// Polyfill Buffer on the global object for Midnight JS SDK
globalThis.Buffer = Buffer;
