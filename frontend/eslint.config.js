import security from 'eslint-plugin-security';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
    },
    linterOptions: {
      // Suppress errors for disable directives referencing plugins that are
      // not fully configured in this security-only config.
      reportUnusedDisableDirectives: false,
    },
    plugins: {
      security,
      // Register react-hooks plugin so that eslint-disable comments referencing
      // react-hooks/exhaustive-deps in the source files are resolved without error.
      'react-hooks': reactHooks,
    },
    rules: {
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-unsafe-regex': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-child-process': 'warn',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-pseudoRandomBytes': 'error',
    },
  },
];
