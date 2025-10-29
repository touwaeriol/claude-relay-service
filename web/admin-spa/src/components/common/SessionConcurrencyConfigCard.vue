<template>
  <div>
    <!-- 主开关 -->
    <label class="flex items-start">
      <input
        :checked="modelValue.enabled"
        class="mt-1 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
        type="checkbox"
        @change="handleToggle"
      />
      <div class="ml-3 flex-1">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300"> 启用会话并发限制 </span>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          限制时间窗口内的唯一会话数量，防止会话过载
        </p>
        <p class="mt-2 text-xs text-amber-600 dark:text-amber-400">
          会话并发仅对 Claude API 生效，其它入口将忽略此限制
        </p>

        <!-- 展开的配置区域 -->
        <div
          v-if="modelValue.enabled"
          class="mt-3 space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50"
        >
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <!-- 最大会话数 -->
            <div>
              <label class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                最大会话数
              </label>
              <input
                class="form-input w-full rounded-lg border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                min="1"
                placeholder="默认10"
                required
                type="number"
                :value="modelValue.maxSessions"
                @input="handleInput('maxSessions', $event)"
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                时间窗口内允许的最大唯一会话数
              </p>
            </div>

            <!-- 时间窗口(秒) -->
            <div>
              <label class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                时间窗口(秒)
              </label>
              <input
                class="form-input w-full rounded-lg border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                min="60"
                placeholder="默认3600"
                required
                type="number"
                :value="modelValue.windowSeconds"
                @input="handleInput('windowSeconds', $event)"
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                统计会话数的时间窗口（最小60秒）
              </p>
            </div>
          </div>

          <!-- 提示信息 -->
          <div class="flex items-start gap-2 rounded-md bg-blue-50 p-2 dark:bg-blue-900/20">
            <i class="fas fa-info-circle mt-0.5 text-xs text-blue-500 dark:text-blue-400"></i>
            <p class="text-xs text-blue-700 dark:text-blue-300">
              会话并发限制用于控制同一时间窗口内的唯一会话数量，与请求并发控制独立工作。例如：设置最大会话数为10，时间窗口为3600秒，则1小时内最多允许10个不同的会话使用该账户。
            </p>
          </div>
        </div>
      </div>
    </label>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: {
    type: Object,
    required: true,
    default: () => ({
      enabled: false,
      maxSessions: 10,
      windowSeconds: 3600
    })
  }
})

const emit = defineEmits(['update:modelValue'])

const handleToggle = (event) => {
  emit('update:modelValue', {
    ...props.modelValue,
    enabled: event.target.checked
  })
}

const handleInput = (field, event) => {
  let value = event.target.value === '' ? null : Number(event.target.value)

  // 输入验证
  if (field === 'maxSessions' && value !== null && value < 1) {
    value = 1
  }
  if (field === 'windowSeconds' && value !== null && value < 60) {
    value = 60
  }

  emit('update:modelValue', {
    ...props.modelValue,
    [field]: value
  })
}
</script>

<style scoped>
.form-input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}
</style>
