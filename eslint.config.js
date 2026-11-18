// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // load-tests/ holds k6 scripts and the throwaway-stack harness, not server code: k6 globals
    // (__VU, __ENV, open, …) and the plain-JS harness are not subject to the server lint rules.
    ignores: ['dist/**', 'src/generated/**', 'docs/evidence/**', 'load-tests/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // AGENTS.md: no console.log anywhere in server code, including boot/shutdown. The
      // structured logger (src/http/logger.ts) writes to stdout directly instead.
      'no-console': 'error',
    },
  },
);
