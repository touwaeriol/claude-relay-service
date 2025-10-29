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
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
          {{ title }}
        </span>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {{ description }}
        </p>

        <!-- 展开的配置区域 -->
        <div
          v-if="modelValue.enabled"
          class="mt-3 space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50"
        >
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <!-- 最大并发数 -->
            <div>
              <label class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                最大并发数
              </label>
              <input
                class="form-input w-full rounded-lg border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                min="1"
                :placeholder="placeholders.maxConcurrency || '默认10'"
                required
                type="number"
                :value="modelValue.maxConcurrency"
                @input="handleInput('maxConcurrency', $event)"
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">同时处理的最大请求数</p>
            </div>

            <!-- 队列长度 -->
            <div>
              <label class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                队列长度
              </label>
              <input
                class="form-input w-full rounded-lg border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                min="0"
                :placeholder="placeholders.queueSize || '默认20'"
                type="number"
                :value="modelValue.queueSize"
                @input="handleInput('queueSize', $event)"
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                设为 0 时超出立即拒绝，大于 0 时排队等待
              </p>
            </div>

            <!-- 等待超时 -->
            <div>
              <label class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                等待超时(秒)
              </label>
              <input
                class="form-input w-full rounded-lg border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                min="1"
                :placeholder="placeholders.queueTimeout || '默认120'"
                type="number"
                :value="modelValue.queueTimeout"
                @input="handleInput('queueTimeout', $event)"
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                队列等待超时时间，超时返回 503
              </p>
            </div>
          </div>

          <!-- 适用 API 类型 -->
          <div class="mt-3">
            <label class="mb-2 block text-xs font-medium text-gray-600 dark:text-gray-400">
              适用 API 类型
            </label>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label
                v-for="service in availableServices"
                :key="service.value"
                class="flex cursor-pointer items-center rounded-md border px-3 py-2 text-sm transition-colors"
                :class="
                  isServiceSelected(service.value)
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300'
                    : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:border-gray-500'
                "
              >
                <input
                  :checked="isServiceSelected(service.value)"
                  class="mr-2 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                  type="checkbox"
                  @change="handleServiceToggle(service.value, $event)"
                />
                {{ service.label }}
              </label>
            </div>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              不勾选任何类型时，并发限制将应用于所有 API 入口；勾选后仅对选中的 API 类型生效
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
      maxConcurrency: 10,
      queueSize: 20,
      queueTimeout: 120,
      targetServices: []
    })
  },
  title: {
    type: String,
    default: '启用并发控制'
  },
  description: {
    type: String,
    default: '限制最大并发请求数，超出时可选择排队等待或立即拒绝'
  },
  placeholders: {
    type: Object,
    default: () => ({
      maxConcurrency: '默认10',
      queueSize: '默认20',
      queueTimeout: '默认120'
    })
  }
})

const emit = defineEmits(['update:modelValue'])

// 可用的服务类型
const availableServices = [
  { label: 'Claude API', value: 'claude' },
  { label: 'Gemini API', value: 'gemini' },
  { label: 'OpenAI API', value: 'openai' },
  { label: 'Droid API', value: 'droid' }
]

const handleToggle = (event) => {
  emit('update:modelValue', {
    ...props.modelValue,
    enabled: event.target.checked
  })
}

const handleInput = (field, event) => {
  const value = event.target.value === '' ? null : Number(event.target.value)
  emit('update:modelValue', {
    ...props.modelValue,
    [field]: value
  })
}

const isServiceSelected = (serviceValue) => {
  const targetServices = props.modelValue.targetServices || []
  return targetServices.includes(serviceValue)
}

const handleServiceToggle = (serviceValue, event) => {
  const targetServices = Array.isArray(props.modelValue.targetServices)
    ? props.modelValue.targetServices
    : []
  const normalizedValue =
    typeof serviceValue === 'string' ? serviceValue.toLowerCase() : serviceValue
  const next = new Set(targetServices.map((s) => (typeof s === 'string' ? s.toLowerCase() : s)))

  if (event.target.checked) {
    next.add(normalizedValue)
  } else {
    next.delete(normalizedValue)
  }

  emit('update:modelValue', {
    ...props.modelValue,
    targetServices: Array.from(next)
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
