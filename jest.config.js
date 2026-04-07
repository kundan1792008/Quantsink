module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageDirectory: 'coverage',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.server.json' }],
  },
};
