import { setTheme } from './utils/theme.js';
import { callAPI } from './services/chat.js';
import { chatManager } from './utils/chat-manager.js';
import { appendMessage } from './handlers/message-handler.js';
import { hideContextMenu } from './components/context-menu.js';
import { initChatContainer } from './components/chat-container.js';
import { showImagePreview, hideImagePreview } from './utils/ui.js';
import { renderAPICards, createCardCallbacks, selectCard } from './components/api-card.js';
import { storageAdapter, syncStorageAdapter, browserAdapter, isExtensionEnvironment } from './utils/storage-adapter.js';
import { initMessageInput, getFormattedMessageContent, buildMessageContent, clearMessageInput, handleWindowMessage } from './components/message-input.js';
import './utils/viewport.js';
import {
    hideChatList,
    initChatListEvents,
    loadChatContent,
    initializeChatList,
    renderChatList
} from './components/chat-list.js';
import { initWebpageMenu, getEnabledTabsContent } from './components/webpage-menu.js';

// 存储用户的问题历史
let userQuestions = [];

// 将 API 配置提升到模块作用域，以确保在异步事件中状态的稳定性
// 加载保存的 API 配置
let apiConfigs = [];
let selectedConfigIndex = 0;

document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    const copyCodeButton = document.getElementById('copy-code');
    const copyImageButton = document.getElementById('copy-image');
    const stopUpdateButton = document.getElementById('stop-update');
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const feedbackButton = document.getElementById('feedback-button');
    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const chatListPage = document.getElementById('chat-list-page');
    const newChatButton = document.getElementById('new-chat');
    const chatListButton = document.getElementById('chat-list');
    const apiSettings = document.getElementById('api-settings');
    const deleteMessageButton = document.getElementById('delete-message');
    const regenerateMessageButton = document.getElementById('regenerate-message');
    const webpageQAContainer = document.getElementById('webpage-qa');
    const webpageContentMenu = document.getElementById('webpage-content-menu');

    // 修改: 创建一个对象引用来保存当前控制器
    const abortControllerRef = { current: null };
    let currentController = null;

    // 创建UI工具配置
    const uiConfig = {
        textarea: {
            maxHeight: 200
        },
        imagePreview: {
            previewModal,
            previewImage
        },
        imageTag: {
            onImageClick: (base64Data) => {
                showImagePreview({
                    base64Data,
                    config: uiConfig.imagePreview
                });
            },
            onDeleteClick: (container) => {
                container.remove();
                messageInput.dispatchEvent(new Event('input'));
            }
        }
    };

    // 添加反馈按钮点击事件
    feedbackButton.addEventListener('click', () => {
        const newIssueUrl = 'https://github.com/yym68686/Cerebr/issues/new';
        window.open(newIssueUrl, '_blank');
        settingsMenu.classList.remove('visible'); // 使用 classList 来正确切换菜单状态
    });

    // 初始化聊天容器
    const chatContainerManager = initChatContainer({
        chatContainer,
        messageInput,
        contextMenu,
        userQuestions,
        chatManager
    });

    // 设置按钮事件处理
    chatContainerManager.setupButtonHandlers({
        copyMessageButton,
        copyCodeButton,
        copyImageButton,
        stopUpdateButton,
        deleteMessageButton,
        regenerateMessageButton,
        abortController: abortControllerRef,
        regenerateMessage: regenerateMessage,
    });

    // 初始化消息输入组件
    initMessageInput({
        messageInput,
        sendMessage,
        userQuestions,
        contextMenu,
        hideContextMenu: hideContextMenu.bind(null, {
            contextMenu,
            onMessageElementReset: () => { /* 清空引用 */ }
        }),
        uiConfig,
        settingsMenu,
        webpageContentMenu // 传递二级菜单
    });

    // 初始化ChatManager
    await chatManager.initialize();

    // 初始化用户问题历史
    chatContainerManager.initializeUserQuestions();

    // 初始化对话列表组件
    initChatListEvents({
        chatListPage,
        chatCards: chatListPage.querySelector('.chat-cards'),
        chatManager,
        loadChatContent: (chat) => loadChatContent(chat, chatContainer),
        onHide: hideChatList.bind(null, chatListPage)
    });

    // 初始化聊天列表功能
    initializeChatList({
        chatListPage,
        chatManager,
        newChatButton,
        chatListButton,
        settingsMenu,
        apiSettings,
        loadChatContent: (chat) => loadChatContent(chat, chatContainer)
    });

    // 加载当前对话内容
    const currentChat = chatManager.getCurrentChat();
    if (currentChat) {
        await loadChatContent(currentChat, chatContainer);
    }

    if ((!currentChat || currentChat.messages.length === 0) && isExtensionEnvironment) {
        const currentTab = await browserAdapter.getCurrentTab();
        if (currentTab) {
            await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
        }
    }

    // 如果不是扩展环境，隐藏网页问答功能
    if (!isExtensionEnvironment) {
        webpageQAContainer.style.display = 'none';
    }


    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        // 使用消息输入组件的窗口消息处理函数
        handleWindowMessage(event, {
            messageInput,
            newChatButton,
            uiConfig
        });
    });

    // 新增：带重试逻辑的API调用函数
    async function callAPIWithRetry(apiParams, chatManager, chatId, onMessageUpdate, maxRetries = 10) {
        let attempt = 0;
        while (attempt <= maxRetries) {
            const { processStream, controller } = await callAPI(apiParams, chatManager, chatId, onMessageUpdate);
            currentController = controller;
            abortControllerRef.current = controller;

            const result = await processStream();

            // 如果 content 为空但 reasoning_content 不为空，则可能被截断，进行重试
            if (result && !result.content && result.reasoning_content && attempt < maxRetries) {
                console.log(`API响应可能被截断，正在重试... (尝试次数 ${attempt + 1})`);
                attempt++;
                // 在重试前，将不完整的 assistant 消息从历史记录中移除
                chatManager.popMessage();
            } else {
                return; // 成功或达到最大重试次数
            }
        }
    }

    async function regenerateMessage(messageElement) {
        if (!messageElement) return;

        // 如果有正在更新的AI消息，停止它
        const updatingMessage = chatContainer.querySelector('.ai-message.updating');
        if (updatingMessage && currentController) {
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null;
            updatingMessage.classList.remove('updating');
        }

        let userMessageElement = null;
        let aiMessageElement = null;
        if (messageElement.classList.contains('user-message')) {
            userMessageElement = messageElement;
            aiMessageElement = messageElement.nextElementSibling;
        } else {
            userMessageElement = messageElement.previousElementSibling;
            aiMessageElement = messageElement;
        }

        if (!userMessageElement || !userMessageElement.classList.contains('user-message')) {
            console.error('无法找到对应的用户消息');
            return;
        }

        try {
            const currentChat = chatManager.getCurrentChat();
            if (!currentChat) return;

            const domMessages = Array.from(chatContainer.querySelectorAll('.user-message, .ai-message'));
            const aiMessageDomIndex = domMessages.indexOf(aiMessageElement);

            // 通过比较DOM和历史记录中的消息数量，判断是否在从一个临时错误消息中重新生成
            const historyMessages = currentChat.messages.filter(m => ['user', 'assistant'].includes(m.role));
            if (domMessages.length === historyMessages.length && aiMessageDomIndex !== -1) {
                // 正常情况：重新生成一个已保存的响应。
                // 我们需要从历史记录中删除旧的响应。
                currentChat.messages.splice(aiMessageDomIndex);
            } else if (domMessages.length === historyMessages.length + 2) {
                currentChat.messages.push({
                    role: 'user',
                    content: userMessageElement.textContent
                });
            }
            // 错误情况：如果 domMessages.length > historyMessages.length，
            // 意味着最后一个消息是未保存的错误消息。
            // 在这种情况下，我们不修改历史记录，因为它已经是正确的了。
            chatManager.saveChats();

            // 从DOM中移除AI消息（无论是错误消息还是旧的成功消息）及其之后的所有消息
            domMessages.slice(currentChat.messages.length).forEach(el => el.remove());

            const messagesToResend = currentChat.messages;

            // 准备API调用参数
            const apiParams = {
                messages: messagesToResend,
                apiConfig: apiConfigs[selectedConfigIndex],
                userLanguage: navigator.language,
                webpageInfo: isExtensionEnvironment ? await getEnabledTabsContent() : null
            };

            // 调用带重试逻辑的 API
            await callAPIWithRetry(apiParams, chatManager, currentChat.id, chatContainerManager.syncMessage);

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                return;
            }
            console.error('重新生成消息失败:', error);
            appendMessage({
                text: '重新生成失败: ' + error.message,
                sender: 'ai',
                chatContainer,
                skipHistory: true,
            });
        } finally {
            const lastMessage = chatContainer.querySelector('.ai-message:last-child');
            if (lastMessage) {
                lastMessage.classList.remove('updating');
            }
        }
    }

    async function sendMessage() {
        // 如果有正在更新的AI消息，停止它
        const updatingMessage = chatContainer.querySelector('.ai-message.updating');
        if (updatingMessage && currentController) {
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null; // 同步更新引用对象
            updatingMessage.classList.remove('updating');
        }

        // 获取格式化后的消息内容
        const { message, imageTags } = getFormattedMessageContent(messageInput);

        if (!message.trim() && imageTags.length === 0) return;

        try {
            // 构建消息内容
            const content = buildMessageContent(message, imageTags);

            // 构建用户消息
            const userMessage = {
                role: "user",
                content: content
            };

            // 先添加用户消息到界面和历史记录
            appendMessage({
                text: userMessage,
                sender: 'user',
                chatContainer,
            });

            // 清空输入框并调整高度
            clearMessageInput(messageInput, uiConfig);

            // 构建消息数组
            const currentChat = chatManager.getCurrentChat();
            const messages = currentChat ? [...currentChat.messages] : [];  // 从chatManager获取消息历史
            messages.push(userMessage);
            chatManager.addMessageToCurrentChat(userMessage);

            // 准备API调用参数
            const apiParams = {
                messages,
                apiConfig: apiConfigs[selectedConfigIndex],
                userLanguage: navigator.language,
                webpageInfo: isExtensionEnvironment ? await getEnabledTabsContent() : null
            };

            // 调用带重试逻辑的 API
            await callAPIWithRetry(apiParams, chatManager, currentChat.id, chatContainerManager.syncMessage);

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                return;
            }
            console.error('发送消息失败:', error);
            appendMessage({
                text: '发送失败: ' + error.message,
                sender: 'ai',
                chatContainer,
                skipHistory: true,
            });
            // 从 chatHistory 中移除最后一条记录（用户的问题）
            const currentChat = chatManager.getCurrentChat();
            const messages = currentChat ? [...currentChat.messages] : [];
            if (messages.length > 0) {
                if (messages[messages.length - 1].role === 'assistant') {
                    chatManager.popMessage();
                    chatManager.popMessage();
                } else {
                    chatManager.popMessage();
                }
            }
        } finally {
            const lastMessage = chatContainer.querySelector('.ai-message:last-child');
            if (lastMessage) {
                lastMessage.classList.remove('updating');
            }
        }
    }

    // 修改点击事件监听器
    document.addEventListener('click', (e) => {
        // 如果点击的不是设置按钮本身和设置菜单，就关闭菜单
        if (!settingsButton.contains(e.target) && !settingsMenu.contains(e.target)) {
            settingsMenu.classList.remove('visible');
        }
       if (!webpageQAContainer.contains(e.target) && !webpageContentMenu.contains(e.target)) {
           webpageContentMenu.classList.remove('visible');
       }
    });

   // 初始化网页内容二级菜单
   if (isExtensionEnvironment) {
    initWebpageMenu({ webpageQAContainer, webpageContentMenu });
   }

    // 确保设置按钮的点击事件在文档点击事件之前处理
    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = settingsMenu.classList.toggle('visible');

        // 如果设置菜单被隐藏，也一并隐藏网页内容菜单
        if (!isVisible) {
            webpageContentMenu.classList.remove('visible');
        }
    });

    // 主题切换
    const themeSwitch = document.getElementById('theme-switch');

    // 创建主题配置对象
    const themeConfig = {
        root: document.documentElement,
        themeSwitch,
        saveTheme: async (theme) => await syncStorageAdapter.set({ theme })
    };

    // 初始化主题
    async function initTheme() {
        try {
            const result = await syncStorageAdapter.get('theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const isDark = result.theme === 'dark' || (!result.theme && prefersDark);
            setTheme(isDark, themeConfig);
        } catch (error) {
            console.error('初始化主题失败:', error);
            // 如果出错，使用系统主题
            setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches, themeConfig);
        }
    }

    // 监听主题切换
    themeSwitch.addEventListener('change', () => {
        setTheme(themeSwitch.checked, themeConfig);
    });

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async (e) => {
        const data = await syncStorageAdapter.get('theme');
        if (!data.theme) {  // 只有在用户没有手动设置主题时才跟随系统
            setTheme(e.matches, themeConfig);
        }
    });

    // 初始化主题
    await initTheme();

    // API 设置功能
    const apiSettingsToggle = document.getElementById('api-settings-toggle');
    const backButton = document.querySelector('.back-button');
    const apiCards = document.querySelector('.api-cards');

    // 使用新的selectCard函数
    const handleCardSelect = (template, index) => {
        selectCard({
            template,
            index,
            onIndexChange: (newIndex) => {
                selectedConfigIndex = newIndex;
            },
            onSave: saveAPIConfigs,
            cardSelector: '.api-card',
            onSelect: () => {
                // 关闭API设置面板
                apiSettings.classList.remove('visible');
            }
        });
    };

    // 创建渲染API卡片的辅助函数
    const renderAPICardsWithCallbacks = () => {
        renderAPICards({
            apiConfigs,
            apiCardsContainer: apiCards,
            templateCard: document.querySelector('.api-card.template'),
            ...createCardCallbacks({
                selectCard: handleCardSelect,
                apiConfigs,
                selectedConfigIndex,
                saveAPIConfigs,
                renderAPICardsWithCallbacks
            }),
            selectedIndex: selectedConfigIndex
        });
    };

    // 从存储加载配置
    async function loadAPIConfigs() {
        try {
            // 统一使用 syncStorageAdapter 来实现配置同步
            const result = await syncStorageAdapter.get(['apiConfigs', 'selectedConfigIndex']);

            // 分别检查每个配置项
            if (result.apiConfigs) {
                apiConfigs = result.apiConfigs;
            } else {
                apiConfigs = [{
                    apiKey: '',
                    baseUrl: 'https://api.openai.com/v1/chat/completions',
                    modelName: 'gpt-4o'
                }];
                // 只有在没有任何配置的情况下才保存默认配置
                await saveAPIConfigs();
            }

            // 只有当 selectedConfigIndex 为 undefined 或 null 时才使用默认值 0
            selectedConfigIndex = result.selectedConfigIndex ?? 0;

            // 确保一定会渲染卡片
            renderAPICardsWithCallbacks();
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            // 只有在出错的情况下才使用默认值
            apiConfigs = [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-4o'
            }];
            selectedConfigIndex = 0;
            renderAPICardsWithCallbacks();
        }
    }

    // 监听标签页切换
    browserAdapter.onTabActivated(async () => {
        // console.log('标签页切换，重新加载API配置');
        // await loadWebpageSwitch();
        // 同步API配置
        await loadAPIConfigs();
        renderAPICardsWithCallbacks();

        // 同步对话列表
        await chatManager.initialize();
        await renderChatList(
            chatManager,
            chatListPage.querySelector('.chat-cards')
        );

        // 如果当前对话为空，则重置网页内容开关
        const currentChat = chatManager.getCurrentChat();
        if (currentChat && currentChat.messages.length === 0) {
            const currentTab = await browserAdapter.getCurrentTab();
            if (currentTab) {
                await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
            }
        }
    });
    // 保存配置到存储
    async function saveAPIConfigs() {
        try {
            // 统一使用 syncStorageAdapter 来实现配置同步
            await syncStorageAdapter.set({
                apiConfigs,
                selectedConfigIndex
            });
        } catch (error) {
            console.error('保存 API 配置失败:', error);
        }
    }

    // 等待 DOM 加载完成后再初始化
    await loadAPIConfigs();

    // 显示/隐藏 API 设置
    apiSettingsToggle.addEventListener('click', () => {
        apiSettings.classList.add('visible');
        settingsMenu.classList.remove('visible');
        // 确保每次打开设置时都重新渲染卡片
        renderAPICardsWithCallbacks();
    });

    // 返回聊天界面
    backButton.addEventListener('click', () => {
        apiSettings.classList.remove('visible');
    });

    // 图片预览功能
    const closeButton = previewModal.querySelector('.image-preview-close');

    closeButton.addEventListener('click', () => {
        hideImagePreview({ config: uiConfig.imagePreview });
    });

    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            hideImagePreview({ config: uiConfig.imagePreview });
        }
    });
});