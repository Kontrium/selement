// Silence and filter out browser extension errors (e.g. Talisman extension onboarding errors)
// which are injected by the user's browser but not part of our application.
(function filterExtensionErrors() {
  if (typeof window === "undefined") return;

  const isExtensionError = (message: string) => {
    return (
      message.includes("Talisman") ||
      message.includes("talisman") ||
      message.includes("extension has not been configured yet")
    );
  };

  // 1. Intercept unhandled runtime errors
  const originalOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    const errorMsg = String(message || "") + " " + String(error?.message || "");
    if (isExtensionError(errorMsg)) {
      return true; // Prevents the firing of the default event handler
    }
    if (originalOnError) {
      return originalOnError.apply(this, arguments as any);
    }
    return false;
  };

  window.addEventListener(
    "error",
    (event) => {
      const errorMsg = String(event.message || "") + " " + String(event.error?.message || "");
      if (isExtensionError(errorMsg)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    },
    true
  );

  // 2. Intercept unhandled promise rejections
  window.addEventListener(
    "unhandledrejection",
    (event) => {
      const reason = event.reason;
      const errorMsg = reason?.message || String(reason || "");
      if (isExtensionError(errorMsg)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    },
    true
  );

  // 3. Prevent logging to console
  const originalConsoleError = console.error;
  console.error = function (...args) {
    const message = args
      .map((arg) => {
        if (arg instanceof Error) {
          return arg.message + " " + arg.stack;
        }
        try {
          return typeof arg === "object" ? JSON.stringify(arg) : String(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");

    if (isExtensionError(message)) {
      return; // Ignore and completely suppress the error
    }
    originalConsoleError.apply(console, args);
  };
})();

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
