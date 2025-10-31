/**
 * 错误码常量定义
 *
 * 集中定义系统中使用的错误码，便于维护和复用。
 * 这些错误码用于标识特定类型的错误，便于错误处理和监控。
 *
 * @module constants/errorCodes
 */

/**
 * 并发控制相关错误码
 */
const CONCURRENCY_ERRORS = {
  /**
   * 队列已满，无法接受新请求
   * 使用场景：Bottleneck 队列达到 highWater 限制
   */
  QUEUE_FULL: 'QUEUE_FULL',

  /**
   * 等待超时，请求在队列中等待时间超过配置的超时时间
   * 使用场景：Bottleneck expiration 超时
   */
  TIMEOUT: 'TIMEOUT',

  /**
   * 客户端断开连接
   * 使用场景：客户端在获取槽位或执行过程中断开连接（close/aborted事件）
   */
  CLIENT_DISCONNECTED: 'CLIENT_DISCONNECTED'
}

/**
 * 会话并发控制相关错误码
 */
const SESSION_CONCURRENCY_ERRORS = {
  /**
   * 会话并发数超过限制
   * 使用场景：账户在时间窗口内的活跃会话数达到上限
   */
  SESSION_LIMIT_EXCEEDED: 'SESSION_LIMIT_EXCEEDED',

  /**
   * 无效的账户ID
   * 使用场景：accountId 参数缺失或格式错误
   */
  INVALID_ACCOUNT_ID: 'INVALID_ACCOUNT_ID',

  /**
   * 无效的配置
   * 使用场景：配置参数验证失败
   */
  INVALID_CONFIG: 'INVALID_CONFIG'
}

/**
 * Redis 相关错误码
 */
const REDIS_ERRORS = {
  /**
   * Redis 错误
   * 使用场景：Redis 连接失败、操作失败等
   */
  REDIS_ERROR: 'REDIS_ERROR'
}

/**
 * 所有错误码（方便统一引用）
 */
const ERROR_CODES = {
  ...CONCURRENCY_ERRORS,
  ...SESSION_CONCURRENCY_ERRORS,
  ...REDIS_ERRORS
}

module.exports = {
  ERROR_CODES,
  CONCURRENCY_ERRORS,
  SESSION_CONCURRENCY_ERRORS,
  REDIS_ERRORS
}
