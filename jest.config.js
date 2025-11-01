module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/app.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000, // 30秒超时（某些测试需要等待）
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  verbose: true,
  // 忽略 node_modules 和其他目录
  testPathIgnorePatterns: [
    '/node_modules/',
    '/web/',
    '/cli/'
  ]
}
