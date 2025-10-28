/**
 * 会话并发控制配置标准化工具
 *
 * 提供统一的配置解析、验证和标准化功能，避免重复代码。
 *
 * @module utils/sessionConcurrencyConfigHelper
 */

/**
 * 默认配置值
 * @constant
 * @type {Object}
 */
const DEFAULT_CONFIG = {
  enabled: false,
  maxSessions: 10,
  windowSeconds: 3600 // 1小时
}

/**
 * 将值转换为数字，失败时返回fallback
 * @private
 * @param {*} value - 要转换的值
 * @param {number} fallback - 转换失败时的回退值
 * @returns {number}
 */
function toNumber(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

/**
 * 限制值的最小值
 * @private
 * @param {number} value - 要限制的值
 * @param {number} min - 最小值
 * @returns {number}
 */
function clamp(value, min) {
  if (!Number.isFinite(value)) {
    return min
  }
  return value < min ? min : value
}

/**
 * 标准化会话并发控制配置
 *
 * 处理各种输入格式，确保返回有效的配置对象：
 * - null/undefined → 返回默认配置（禁用）
 * - 字符串 → 尝试JSON.parse，失败则返回默认配置
 * - 对象 → 验证并标准化各字段
 *
 * 字段验证规则：
 * - enabled: 转换为布尔值（支持 true/'true'/1/'1'）
 * - maxSessions: 转换为整数，最小值为1
 * - windowSeconds: 转换为整数，最小值为60秒
 *
 * @param {Object|string|null} rawConfig - 原始配置
 * @returns {Object} 标准化后的配置对象
 *
 * @example
 * // 返回默认配置
 * normalizeConfig(null)
 * // => { enabled: false, maxSessions: 10, windowSeconds: 3600 }
 *
 * @example
 * // 处理字符串配置
 * normalizeConfig('{"enabled": true, "maxSessions": "5"}')
 * // => { enabled: true, maxSessions: 5, windowSeconds: 3600 }
 *
 * @example
 * // 处理对象配置并验证边界值
 * normalizeConfig({ enabled: 'true', maxSessions: 0, windowSeconds: 30 })
 * // => { enabled: true, maxSessions: 1, windowSeconds: 60 }
 */
function normalizeConfig(rawConfig) {
  // 处理null/undefined
  if (!rawConfig) {
    return { ...DEFAULT_CONFIG }
  }

  // 处理字符串（尝试JSON解析）
  let parsed = rawConfig
  if (typeof rawConfig === 'string') {
    try {
      parsed = JSON.parse(rawConfig)
    } catch (error) {
      // JSON解析失败，返回默认配置
      return { ...DEFAULT_CONFIG }
    }
  }

  // 确保parsed是对象
  if (!parsed || typeof parsed !== 'object') {
    return { ...DEFAULT_CONFIG }
  }

  // 标准化各字段
  const normalized = { ...DEFAULT_CONFIG }

  // enabled: 支持多种真值表示
  if (Object.prototype.hasOwnProperty.call(parsed, 'enabled')) {
    normalized.enabled =
      parsed.enabled === true ||
      parsed.enabled === 'true' ||
      parsed.enabled === 1 ||
      parsed.enabled === '1'
  }

  // maxSessions: 转整数，最小值1
  const rawMaxSessions = toNumber(parsed.maxSessions, DEFAULT_CONFIG.maxSessions)
  normalized.maxSessions = clamp(Math.floor(rawMaxSessions), 1)

  // windowSeconds: 转整数，最小值60秒
  const rawWindowSeconds = toNumber(parsed.windowSeconds, DEFAULT_CONFIG.windowSeconds)
  normalized.windowSeconds = clamp(Math.floor(rawWindowSeconds), 60)

  return normalized
}

/**
 * 验证配置是否有效
 * @param {Object} config - 要验证的配置
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateConfig(config) {
  const errors = []

  if (!config || typeof config !== 'object') {
    errors.push('Config must be an object')
    return { valid: false, errors }
  }

  if (typeof config.enabled !== 'boolean') {
    errors.push('enabled must be a boolean')
  }

  if (!Number.isInteger(config.maxSessions) || config.maxSessions < 1) {
    errors.push('maxSessions must be an integer >= 1')
  }

  if (!Number.isInteger(config.windowSeconds) || config.windowSeconds < 60) {
    errors.push('windowSeconds must be an integer >= 60')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  validateConfig
}
