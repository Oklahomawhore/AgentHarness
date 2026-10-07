/** Locale bundles for the plugin configuration section and its plugin cards. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'configurableTab' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'subagentModelSelectionTitle' | 'subagentModelSelectionDescription'
  | 'subagentModelSelectionToggle' | 'subagentModelSelectionChoose' | 'subagentModelSelectionAllowed'
  | 'subagentModelSelectionLoading' | 'subagentModelSelectionLoadFailed' | 'subagentModelSelectionRetry'
  | 'subagentModelSelectionPartial' | 'subagentModelSelectionUnavailable'
  | 'subagentModelSelectionUnavailableGroup' | 'subagentModelSelectionEmpty'
  | 'scopeNetworkTitle' | 'scopeNetworkDescription' | 'scopeNetworkMode' | 'scopeNetworkLocal'
  | 'scopeNetworkLan' | 'scopeNetworkCustom' | 'scopeNetworkPort' | 'scopeNetworkLocalHint'
  | 'scopeNetworkLanHint' | 'scopeNetworkInvalidPort' | 'scopeNetworkCustomHint' | 'scopeNetworkRestart'
  | 'scopeNetworkPermission' | 'scopeNetworkRemote' | 'scopeNetworkConflict' | 'scopeNetworkSaved'
  | 'subagentModelSelectionRequired' | 'subagentModelSelectionConflict' | 'subagentModelSelectionOff'
  | 'scopeContextTitle'
  | 'scopeContextDescription'
  | 'scopeContextMode'
  | 'scopeContextReported'
  | 'scopeContextSemantic'
  | 'scopeContextModel'
  | 'scopeContextChoose'
  | 'scopeContextUnavailable'
  | 'scopeContextLoading'
  | 'scopeContextLoadFailed'
  | 'scopeContextPartial'
  | 'scopeContextRetry'
  | 'scopeContextMaxCalls'
  | 'scopeContextBudgetHint'
  | 'scopeContextDisclosure'
  | 'scopeContextInvalid'
  | 'scopeContextRestart'
  | 'scopeContextConflict'
  | 'scopeContextSaved'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  scopeContextTitle: 'Collaboration summaries',
  scopeContextDescription: 'Choose how this Host supplies context to authorized collaborators.',
  scopeContextMode: 'Context delivery',
  scopeContextReported: 'Reports without model summaries',
  scopeContextSemantic: 'Model summaries',
  scopeContextModel: 'Summary model',
  scopeContextChoose: 'Choose a model',
  scopeContextUnavailable: 'Currently unavailable',
  scopeContextLoading: 'Loading models…',
  scopeContextLoadFailed: 'Models could not be loaded. You can still switch off model summaries.',
  scopeContextPartial: 'Some providers could not be loaded. Choose an available model or retry.',
  scopeContextRetry: 'Refresh models',
  scopeContextMaxCalls: 'Cumulative summary call limit',
  scopeContextBudgetHint: 'This Host shares one persistent call count across Tasks. Restarting or changing models does not reset it. This is neither an agent work-turn allowance nor a monetary limit.',
  scopeContextDisclosure: 'Authorized shared context is sent to the selected provider using its configured credentials; calls may incur charges. Your Session model stays unchanged. Opening or saving these settings makes no model call.',
  scopeContextInvalid: 'Enter a positive whole-number call limit. Model summaries also require an available model.',
  scopeContextRestart: 'Save from this Host’s authenticated management page, then manually restart the Host. The choice applies to context supplied by this Host.',
  scopeContextConflict: 'Settings or the connection changed. Discard the draft and review the current values before saving.',
  scopeContextSaved: 'Settings saved. Manually restart the Host to apply the summary choice.',
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'Configure and inspect the plugins installed in this deployment.',
  tabs: 'Plugin views',
  configurableTab: 'Plugin configuration',
  empty: 'This deployment exposes no plugin settings.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'The DeepSeek search provider.',
  webSearchApiKey: 'API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'Endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
  scopeNetworkTitle: 'Collaboration network',
  scopeNetworkDescription: 'Choose where other AgentHarness instances can connect after a Host restart.',
  scopeNetworkMode: 'Collaboration connection scope',
  scopeNetworkLocal: 'Only the device running AgentHarness',
  scopeNetworkLan: 'Allow direct connections from other devices',
  scopeNetworkCustom: 'Custom listeners',
  scopeNetworkPort: 'TCP port',
  scopeNetworkLocalHint: 'Local connections use a port assigned at startup. Other devices cannot use that address.',
  scopeNetworkLanHint: 'Listen on all IPv4 interfaces. Choose a free port from 1 to 65535; the network and firewall must allow the other device to reach it over LAN or VPN.',
  scopeNetworkInvalidPort: 'Enter a whole-number port from 1 to 65535. No port is selected automatically.',
  scopeNetworkCustomHint: 'These saved addresses remain unchanged unless you explicitly select another mode and save.',
  scopeNetworkRestart: 'After saving, manually restart the Host running AgentHarness. Use the invitation addresses actually advertised after restart.',
  scopeNetworkPermission: 'Saving does not confirm reachability, open Web management access, or grant access to any shared Task.',
  scopeNetworkRemote: 'Configure persistent listeners from the local page on the device running AgentHarness.',
  scopeNetworkConflict: 'Settings or the connection changed. Discard the draft and review the current values before saving.',
  scopeNetworkSaved: 'Settings saved; listening does not change immediately. Manually restart the Host, then refresh collaboration addresses.',
  subagentModelSelectionTitle: 'Subagent',
  subagentModelSelectionDescription: 'Control which models agents may choose for subagents.',
  subagentModelSelectionToggle: 'Allow agents to choose models for subagents',
  subagentModelSelectionChoose: 'When enabled, agents can choose a provider, model, and reasoning effort for each subagent from the authorized models below. Applies only to new sessions.',
  subagentModelSelectionAllowed: 'Models agents may choose',
  subagentModelSelectionLoading: 'Loading models…',
  subagentModelSelectionLoadFailed: 'Models could not be loaded.',
  subagentModelSelectionRetry: 'Retry',
  subagentModelSelectionPartial: 'Some model providers could not be loaded; saved choices remain removable.',
  subagentModelSelectionUnavailable: 'Currently unavailable',
  subagentModelSelectionUnavailableGroup: 'Saved but currently unavailable',
  subagentModelSelectionEmpty: 'No model provider currently advertises a model.',
  subagentModelSelectionRequired: 'Select at least one model before saving.',
  subagentModelSelectionConflict: 'Settings changed elsewhere. Discard your draft and try again.',
  subagentModelSelectionOff: 'Subagents use configured defaults or inherit the parent agent\'s model. Saved model choices are retained.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  scopeContextTitle: '协作摘要',
  scopeContextDescription: '选择此 Host 向已授权协作者提供上下文的方式。',
  scopeContextMode: '上下文提供方式',
  scopeContextReported: '报告（不调用摘要模型）',
  scopeContextSemantic: '模型摘要',
  scopeContextModel: '摘要模型',
  scopeContextChoose: '请选择模型',
  scopeContextUnavailable: '当前不可用',
  scopeContextLoading: '正在加载模型…',
  scopeContextLoadFailed: '无法加载模型，仍可关闭模型摘要。',
  scopeContextPartial: '部分提供方暂时无法加载，请选择可用模型或重试。',
  scopeContextRetry: '刷新模型',
  scopeContextMaxCalls: '摘要累计调用上限',
  scopeContextBudgetHint: '此 Host 的所有 Task 共用持久化调用计数，重启或切换模型不会清零。这不是 Agent 自动工作轮数，也不是金额上限。',
  scopeContextDisclosure: '已授权共享的上下文会使用已配置凭据发送给所选提供方，可能产生费用。你的 Session 模型保持不变，打开或保存设置不会调用模型。',
  scopeContextInvalid: '请填写正整数调用上限；开启模型摘要时还需选择可用模型。',
  scopeContextRestart: '请从此 Host 的已认证管理页面保存，再手动重启 Host。此选择影响由该 Host 提供的上下文。',
  scopeContextConflict: '设置或连接已变化，请放弃修改并核对当前值后再保存。',
  scopeContextSaved: '设置已保存，请手动重启 Host 以应用摘要选择。',
  nav: '插件',
  title: '插件',
  intro: '配置和查看本部署已安装的插件。',
  tabs: '插件视图',
  configurableTab: '插件配置',
  empty: '本部署没有开放任何插件设置。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  webSearchTitle: '网页搜索',
  webSearchDescription: 'DeepSeek 搜索提供方。',
  webSearchApiKey: 'API Key',
  webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchApiKeySet: '已配置密钥。',
  webSearchApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
  webSearchBaseUrl: '接口地址',
  webSearchBaseUrlHint: '留空则使用提供方默认地址。',
  webSearchMaxUses: '单次请求最多搜索次数',
  webSearchMaxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
  scopeNetworkTitle: '协作网络',
  scopeNetworkDescription: '选择其他 AgentHarness 实例在 Host 重启后可连接的范围。',
  scopeNetworkMode: '协作连接范围',
  scopeNetworkLocal: '仅运行 AgentHarness 的设备',
  scopeNetworkLan: '允许其他设备直接连接',
  scopeNetworkCustom: '自定义监听',
  scopeNetworkPort: 'TCP 端口',
  scopeNetworkLocalHint: '仅此设备的连接使用启动时分配的端口，其他设备不能使用该地址。',
  scopeNetworkLanHint: '监听所有 IPv4 网络接口。请填写 1–65535 中的可用端口；对方仍需能通过局域网或 VPN 及防火墙访问它。',
  scopeNetworkInvalidPort: '请填写 1–65535 之间的整数端口，不会自动选择端口。',
  scopeNetworkCustomHint: '这些已保存地址会保持不变，只有明确选择另一种范围并保存才会替换。',
  scopeNetworkRestart: '保存后请手动重启运行 AgentHarness 的 Host。邀请地址以重启后服务实际公布的列表为准。',
  scopeNetworkPermission: '保存不能证明对方可达，也不会开放 Web 管理访问或授予任何共享 Task 的权限。',
  scopeNetworkRemote: '请在运行 AgentHarness 的设备上打开本机页面，以配置持久监听。',
  scopeNetworkConflict: '设置或连接已变化。请放弃修改，核对当前值后再保存。',
  scopeNetworkSaved: '设置已保存；当前监听不会立即改变。请手动重启 Host 后刷新协作地址。',
  subagentModelSelectionTitle: 'Subagent',
  subagentModelSelectionDescription: '控制 Agent 为 Subagent 选择模型的权限。',
  subagentModelSelectionToggle: '允许 Agent 为 Subagent 选择模型',
  subagentModelSelectionChoose: '开启后，Agent 可以从下方授权模型中，为每个 Subagent 选择提供方、模型和推理强度。仅影响新会话。',
  subagentModelSelectionAllowed: 'Agent 可选择的模型',
  subagentModelSelectionLoading: '正在加载模型…',
  subagentModelSelectionLoadFailed: '无法加载模型。',
  subagentModelSelectionRetry: '重试',
  subagentModelSelectionPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
  subagentModelSelectionUnavailable: '当前不可用',
  subagentModelSelectionUnavailableGroup: '已保存但当前不可用',
  subagentModelSelectionEmpty: '当前没有模型提供方公布模型。',
  subagentModelSelectionRequired: '保存前请至少选择一个模型。',
  subagentModelSelectionConflict: '设置已在其他位置更新。请放弃修改后重试。',
  subagentModelSelectionOff: '关闭后，Subagent 使用配置的默认模型或继承父 Agent 的模型；已选模型会保留。',
}
